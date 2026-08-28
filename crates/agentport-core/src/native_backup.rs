//! Provider-aware backup and restore of agent-owned native Session artifacts.
//!
//! This module never inventories an entire provider home.  A capture starts
//! from one AgentPort `Session`, resolves the native IDs recorded by the Host,
//! and selects only files that match those IDs (and the recorded cwd where the
//! provider format exposes it).  Restore targets are provider-relative and are
//! installed only when absent or byte-identical; divergent files are never
//! overwritten.

use crate::error::{CoreError, Result};
use crate::history::{
    codex_file_matches, collect_jsonl_files, collect_native_ids, configured_home, cwd_slug,
    read_kimi_session_index, MAX_NATIVE_SOURCES,
};
use crate::models::{AgentType, Session};
use crate::paths::AppPaths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const MAX_FILES_PER_SESSION: usize = 20_000;
const COPY_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeCoverage {
    Complete,
    Missing,
    Ambiguous,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeTargetRoot {
    AgentPort,
    Claude,
    Codex,
    Kimi,
    Qoder,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeArtifact {
    pub archive_path: String,
    pub target_root: NativeTargetRoot,
    pub target_path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KimiIndexBinding {
    pub native_session_id: String,
    pub session_relative_dir: String,
    pub index_entry: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionBackup {
    pub agentport_session_id: String,
    pub provider: AgentType,
    pub native_session_ids: Vec<String>,
    pub cwd: String,
    pub coverage: NativeCoverage,
    pub artifacts: Vec<NativeArtifact>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kimi_bindings: Vec<KimiIndexBinding>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCoverageSummary {
    pub total: u64,
    pub captured: u64,
    pub missing: u64,
    pub ambiguous: u64,
    pub unsupported: u64,
}

impl NativeCoverageSummary {
    pub fn from_sessions(sessions: &[NativeSessionBackup]) -> Self {
        let mut summary = Self {
            total: sessions.len() as u64,
            ..Self::default()
        };
        for session in sessions {
            match session.coverage {
                NativeCoverage::Complete => summary.captured += 1,
                NativeCoverage::Missing => summary.missing += 1,
                NativeCoverage::Ambiguous => summary.ambiguous += 1,
                NativeCoverage::Unsupported => summary.unsupported += 1,
            }
        }
        summary
    }

    pub fn complete(&self) -> bool {
        self.missing == 0 && self.ambiguous == 0
    }
}

#[derive(Debug, Clone)]
struct PlannedFile {
    source: PathBuf,
    target_root: NativeTargetRoot,
    target_path: PathBuf,
}

#[derive(Debug, Clone)]
struct NativeRoots {
    claude: PathBuf,
    codex: PathBuf,
    kimi: PathBuf,
    qoder: PathBuf,
}

impl NativeRoots {
    fn configured() -> Self {
        Self {
            claude: configured_home("CLAUDE_CONFIG_DIR", ".claude"),
            codex: configured_home("CODEX_HOME", ".codex"),
            kimi: configured_home("KIMI_CODE_HOME", ".kimi-code"),
            qoder: configured_home("QODER_HOME", ".qoder"),
        }
    }

    fn target<'a>(&'a self, kind: NativeTargetRoot, agentport: &'a Path) -> &'a Path {
        match kind {
            NativeTargetRoot::AgentPort => agentport,
            NativeTargetRoot::Claude => &self.claude,
            NativeTargetRoot::Codex => &self.codex,
            NativeTargetRoot::Kimi => &self.kimi,
            NativeTargetRoot::Qoder => &self.qoder,
        }
    }
}

#[derive(Debug)]
struct Plan {
    coverage: NativeCoverage,
    files: Vec<PlannedFile>,
    kimi_bindings: Vec<KimiIndexBinding>,
}

fn safe_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn normalized_relative(path: &Path) -> Result<String> {
    if !safe_relative(path) {
        return Err(CoreError::Validation(format!(
            "unsafe native artifact path: {}",
            path.display()
        )));
    }
    Ok(path.to_string_lossy().replace('\\', "/"))
}

fn contained(path: &Path, root: &Path) -> Option<(PathBuf, PathBuf)> {
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    if path == root || !path.starts_with(&root) {
        return None;
    }
    let relative = path.strip_prefix(&root).ok()?.to_path_buf();
    safe_relative(&relative).then_some((path, relative))
}

fn collect_directory_files(
    source_dir: &Path,
    root: &Path,
    target_root: NativeTargetRoot,
    output: &mut Vec<PlannedFile>,
) -> Result<()> {
    let Some((canonical_dir, _)) = contained(source_dir, root) else {
        return Ok(());
    };
    let mut stack = vec![canonical_dir];
    while let Some(dir) = stack.pop() {
        let mut entries = fs::read_dir(&dir)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            if output.len() >= MAX_FILES_PER_SESSION {
                return Err(CoreError::Validation(format!(
                    "native Session has more than {MAX_FILES_PER_SESSION} files"
                )));
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                if contained(&path, root).is_some() {
                    stack.push(path);
                }
            } else if file_type.is_file() {
                if let Some((source, relative)) = contained(&path, root) {
                    output.push(PlannedFile {
                        source,
                        target_root,
                        target_path: relative,
                    });
                }
            }
        }
    }
    Ok(())
}

fn push_file(
    output: &mut Vec<PlannedFile>,
    path: &Path,
    root: &Path,
    target_root: NativeTargetRoot,
) {
    if output.len() >= MAX_FILES_PER_SESSION {
        return;
    }
    if let Some((source, relative)) = contained(path, root) {
        if source.is_file() && !output.iter().any(|known| known.source == source) {
            output.push(PlannedFile {
                source,
                target_root,
                target_path: relative,
            });
        }
    }
}

fn plan_session(paths: &AppPaths, session: &Session, roots: &NativeRoots) -> Result<Plan> {
    if session.adapter_type == AgentType::Shell {
        return Ok(Plan {
            coverage: NativeCoverage::Unsupported,
            files: Vec::new(),
            kimi_bindings: Vec::new(),
        });
    }
    let native_ids = collect_native_ids(paths, session);
    if native_ids.is_empty() {
        return Ok(Plan {
            coverage: NativeCoverage::Missing,
            files: Vec::new(),
            kimi_bindings: Vec::new(),
        });
    }

    let mut files = Vec::new();
    let mut kimi_bindings = Vec::new();
    let mut ambiguous = false;
    match session.adapter_type {
        AgentType::Claude => {
            let project = roots.claude.join("projects").join(cwd_slug(&session.cwd));
            for id in &native_ids {
                push_file(
                    &mut files,
                    &project.join(format!("{id}.jsonl")),
                    &roots.claude,
                    NativeTargetRoot::Claude,
                );
                collect_directory_files(
                    &project.join(id),
                    &roots.claude,
                    NativeTargetRoot::Claude,
                    &mut files,
                )?;
            }
        }
        AgentType::Codex => {
            let sessions_root = roots.codex.join("sessions");
            let mut candidates = Vec::new();
            collect_jsonl_files(&sessions_root, 5, &mut candidates);
            for id in &native_ids {
                let matches = candidates
                    .iter()
                    .filter(|path| codex_file_matches(path, id, &session.cwd))
                    .collect::<Vec<_>>();
                if matches.len() > 1 {
                    ambiguous = true;
                    break;
                }
                if let Some(path) = matches.first() {
                    push_file(&mut files, path, &roots.codex, NativeTargetRoot::Codex);
                }
            }
        }
        AgentType::Pi => {
            let pi_root = paths.session_dir(&session.id).join("pi");
            collect_directory_files(
                &pi_root,
                paths.root(),
                NativeTargetRoot::AgentPort,
                &mut files,
            )?;
        }
        AgentType::Kimi => {
            let wanted = native_ids
                .iter()
                .map(String::as_str)
                .collect::<HashSet<_>>();
            let session_root = roots.kimi.join("sessions");
            let matching = read_kimi_session_index(&roots.kimi)
                .into_iter()
                .filter(|entry| {
                    entry
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| wanted.contains(id))
                        && entry.get("workDir").and_then(Value::as_str)
                            == Some(session.cwd.as_str())
                })
                .collect::<Vec<_>>();
            if matching.len() > MAX_NATIVE_SOURCES {
                ambiguous = true;
            } else {
                let mut seen_kimi_ids = HashSet::new();
                for entry in matching {
                    let Some(id) = entry.get("sessionId").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(dir) = entry.get("sessionDir").and_then(Value::as_str) else {
                        continue;
                    };
                    let dir = PathBuf::from(dir);
                    let Some((_, relative)) = contained(&dir, &session_root) else {
                        continue;
                    };
                    if !seen_kimi_ids.insert(id.to_string()) {
                        ambiguous = true;
                        break;
                    }
                    collect_directory_files(&dir, &roots.kimi, NativeTargetRoot::Kimi, &mut files)?;
                    kimi_bindings.push(KimiIndexBinding {
                        native_session_id: id.to_string(),
                        session_relative_dir: normalized_relative(
                            &Path::new("sessions").join(relative),
                        )?,
                        index_entry: entry,
                    });
                }
            }
        }
        AgentType::Qoder => {
            let sessions_root = roots.qoder.join("logs/sessions");
            let project = sessions_root.join(cwd_slug(&session.cwd));
            for id in &native_ids {
                collect_directory_files(
                    &project.join(id),
                    &roots.qoder,
                    NativeTargetRoot::Qoder,
                    &mut files,
                )?;
            }
        }
        AgentType::Shell => unreachable!(),
    }
    files.sort_by(|left, right| {
        left.target_root
            .as_ref()
            .cmp(right.target_root.as_ref())
            .then(left.target_path.cmp(&right.target_path))
    });
    files.dedup_by(|left, right| {
        left.target_root == right.target_root && left.target_path == right.target_path
    });
    Ok(Plan {
        coverage: if ambiguous {
            NativeCoverage::Ambiguous
        } else if files.is_empty() {
            NativeCoverage::Missing
        } else {
            NativeCoverage::Complete
        },
        files,
        kimi_bindings,
    })
}

impl AsRef<str> for NativeTargetRoot {
    fn as_ref(&self) -> &str {
        match self {
            Self::AgentPort => "agentport",
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Kimi => "kimi",
            Self::Qoder => "qoder",
        }
    }
}

fn copy_fixed_and_hash(source: &Path, destination: &Path) -> Result<(u64, String)> {
    let before = fs::metadata(source)?;
    let expected = before.len();
    let mut reader = File::open(source)?.take(expected);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination)?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; COPY_BUFFER_BYTES];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(read as u64)
            .ok_or_else(|| CoreError::Validation("native artifact size overflow".into()))?;
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }
    if total != expected {
        return Err(CoreError::Conflict(format!(
            "native artifact was truncated during backup: {}",
            source.display()
        )));
    }
    let after = fs::metadata(source)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() || after.len() < expected {
            return Err(CoreError::Conflict(format!(
                "native artifact was replaced during backup: {}",
                source.display()
            )));
        }
    }
    #[cfg(not(unix))]
    if after.len() < expected {
        return Err(CoreError::Conflict(format!(
            "native artifact was truncated during backup: {}",
            source.display()
        )));
    }
    output.flush()?;
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn safe_archive_session_id(id: &str) -> Result<&str> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(CoreError::Validation("unsafe AgentPort Session id".into()));
    }
    Ok(id)
}

/// Resolve and copy one AgentPort Session's native artifacts into `staging`.
/// The returned paths are relative to the eventual backup archive root.
pub fn capture_session(
    paths: &AppPaths,
    session: &Session,
    staging: &Path,
) -> Result<NativeSessionBackup> {
    capture_session_with_roots(paths, session, staging, &NativeRoots::configured())
}

fn capture_session_with_roots(
    paths: &AppPaths,
    session: &Session,
    staging: &Path,
    roots: &NativeRoots,
) -> Result<NativeSessionBackup> {
    let plan = plan_session(paths, session, roots)?;
    let native_ids = collect_native_ids(paths, session);
    let session_id = safe_archive_session_id(&session.id)?;
    let mut artifacts = Vec::with_capacity(plan.files.len());
    if plan.coverage == NativeCoverage::Complete {
        for file in plan.files {
            let target_path = normalized_relative(&file.target_path)?;
            let archive_path = format!(
                "native/{}/{}/{}",
                session_id,
                file.target_root.as_ref(),
                target_path
            );
            let (size, sha256) = copy_fixed_and_hash(&file.source, &staging.join(&archive_path))?;
            artifacts.push(NativeArtifact {
                archive_path,
                target_root: file.target_root,
                target_path,
                size,
                sha256,
            });
        }
    }
    Ok(NativeSessionBackup {
        agentport_session_id: session.id.clone(),
        provider: session.adapter_type,
        native_session_ids: native_ids,
        cwd: session.cwd.clone(),
        coverage: plan.coverage,
        artifacts,
        kimi_bindings: plan.kimi_bindings,
    })
}

fn hash_file(path: &Path) -> Result<(u64, String)> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let size = std::io::copy(&mut file, &mut hasher)?;
    Ok((size, format!("{:x}", hasher.finalize())))
}

fn destination_for(
    roots: &NativeRoots,
    target_agentport_root: &Path,
    artifact: &NativeArtifact,
) -> Result<PathBuf> {
    let relative = Path::new(&artifact.target_path);
    if !safe_relative(relative) {
        return Err(CoreError::Validation(format!(
            "unsafe native restore path: {}",
            artifact.target_path
        )));
    }
    Ok(roots
        .target(artifact.target_root, target_agentport_root)
        .join(relative))
}

fn ensure_safe_parent(root: &Path, relative: &Path) -> Result<()> {
    if !safe_relative(relative) {
        return Err(CoreError::Validation("unsafe native restore path".into()));
    }
    fs::create_dir_all(root)?;
    let mut current = root.to_path_buf();
    for component in relative.parent().into_iter().flat_map(Path::components) {
        let Component::Normal(segment) = component else {
            continue;
        };
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(CoreError::Conflict(
                    "native restore parent contains a symlink".into(),
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(CoreError::Conflict(
                    "native restore parent is not a directory".into(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&current, fs::Permissions::from_mode(0o700))?;
                }
            }
            Err(error) => return Err(CoreError::Io(error)),
        }
    }
    Ok(())
}

fn materialize_with_roots(
    extracted_root: &Path,
    target_agentport_root: &Path,
    sessions: &[NativeSessionBackup],
    roots: &NativeRoots,
) -> Result<NativeMaterializeReport> {
    let mut missing = Vec::new();
    let mut reused = 0u64;
    let mut seen_destinations = HashMap::<PathBuf, String>::new();
    for session in sessions {
        if session.coverage != NativeCoverage::Complete {
            continue;
        }
        for artifact in &session.artifacts {
            let source = extracted_root.join(&artifact.archive_path);
            let (size, hash) = hash_file(&source)?;
            if size != artifact.size || hash != artifact.sha256 {
                return Err(CoreError::Validation(format!(
                    "native backup payload failed integrity check: {}",
                    artifact.archive_path
                )));
            }
            let destination = destination_for(roots, target_agentport_root, artifact)?;
            if let Some(previous_hash) = seen_destinations.insert(destination.clone(), hash.clone())
            {
                if previous_hash != hash {
                    return Err(CoreError::Conflict(
                        "two native Sessions target the same file with different content".into(),
                    ));
                }
            }
            match fs::symlink_metadata(&destination) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(CoreError::Conflict(format!(
                        "native restore target is not a regular file: {}",
                        destination.display()
                    )));
                }
                Ok(_) => {
                    let (existing_size, existing_hash) = hash_file(&destination)?;
                    if existing_size != artifact.size || existing_hash != artifact.sha256 {
                        return Err(CoreError::Conflict(format!(
                            "native restore would overwrite different content: {}",
                            destination.display()
                        )));
                    }
                    reused += 1;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    missing.push((source, destination, artifact.clone()));
                }
                Err(error) => return Err(CoreError::Io(error)),
            }
        }
    }

    let kimi_index = roots.kimi.join("session_index.jsonl");
    let existing_kimi = fs::read(&kimi_index).unwrap_or_default();
    let mut kimi_entries = Vec::<Value>::new();
    for line in existing_kimi.split(|byte| *byte == b'\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(line) {
            kimi_entries.push(value);
        }
    }
    let mut new_kimi = Vec::new();
    for binding in sessions
        .iter()
        .filter(|session| session.coverage == NativeCoverage::Complete)
        .flat_map(|session| session.kimi_bindings.iter())
    {
        let expected_dir = roots.kimi.join(&binding.session_relative_dir);
        let same_id = kimi_entries
            .iter()
            .filter(|entry| {
                entry.get("sessionId").and_then(Value::as_str)
                    == Some(binding.native_session_id.as_str())
            })
            .collect::<Vec<_>>();
        if same_id.len() > 1 {
            return Err(CoreError::Conflict(
                "Kimi session index contains duplicate restored Session IDs".into(),
            ));
        }
        if let Some(entry) = same_id.first() {
            let dir_matches = entry
                .get("sessionDir")
                .and_then(Value::as_str)
                .is_some_and(|value| Path::new(value) == expected_dir);
            let cwd_matches = entry.get("workDir").and_then(Value::as_str)
                == binding.index_entry.get("workDir").and_then(Value::as_str);
            if !dir_matches || !cwd_matches {
                return Err(CoreError::Conflict(
                    "Kimi session index already binds the native ID differently".into(),
                ));
            }
        } else {
            let mut entry = binding.index_entry.clone();
            let Some(object) = entry.as_object_mut() else {
                return Err(CoreError::Validation(
                    "Kimi backup index entry is not an object".into(),
                ));
            };
            object.insert(
                "sessionDir".into(),
                Value::String(expected_dir.to_string_lossy().into_owned()),
            );
            new_kimi.push(entry);
        }
    }

    let mut created = Vec::new();
    let install_result = (|| -> Result<()> {
        for (source, destination, artifact) in &missing {
            let root = roots.target(artifact.target_root, target_agentport_root);
            let relative = Path::new(&artifact.target_path);
            ensure_safe_parent(root, relative)?;
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(destination)?;
            let mut input = File::open(source)?;
            std::io::copy(&mut input, &mut output)?;
            output.flush()?;
            created.push(destination.clone());
        }
        if !new_kimi.is_empty() {
            fs::create_dir_all(&roots.kimi)?;
            let temp = roots.kimi.join(format!(
                ".session_index.restore-{}",
                crate::ids::new_id("tmp")
            ));
            let mut options = OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(&temp)?;
            output.write_all(&existing_kimi)?;
            if !existing_kimi.is_empty() && !existing_kimi.ends_with(b"\n") {
                output.write_all(b"\n")?;
            }
            for entry in &new_kimi {
                serde_json::to_writer(&mut output, entry)?;
                output.write_all(b"\n")?;
            }
            output.flush()?;
            if let Err(error) = fs::rename(&temp, &kimi_index) {
                let _ = fs::remove_file(&temp);
                return Err(CoreError::Io(error));
            }
        }
        Ok(())
    })();
    if let Err(error) = install_result {
        for path in created.iter().rev() {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    Ok(NativeMaterializeReport {
        installed_files: missing.len() as u64,
        reused_files: reused,
        kimi_index_entries: new_kimi.len() as u64,
    })
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMaterializeReport {
    pub installed_files: u64,
    pub reused_files: u64,
    pub kimi_index_entries: u64,
}

/// Install extracted native payloads into the configured provider homes and
/// the not-yet-published AgentPort target root.  Every destination is checked
/// before any write; different existing content is a hard conflict.
pub fn materialize(
    extracted_root: &Path,
    target_agentport_root: &Path,
    sessions: &[NativeSessionBackup],
) -> Result<NativeMaterializeReport> {
    materialize_with_roots(
        extracted_root,
        target_agentport_root,
        sessions,
        &NativeRoots::configured(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentTransport, Lifecycle, PermissionMode, ResumePrecision};
    use chrono::Utc;
    use tempfile::TempDir;

    fn roots(base: &Path) -> NativeRoots {
        NativeRoots {
            claude: base.join("claude"),
            codex: base.join("codex"),
            kimi: base.join("kimi"),
            qoder: base.join("qoder"),
        }
    }

    fn session(paths: &AppPaths, provider: AgentType, native_id: Option<&str>) -> Session {
        Session {
            id: format!("ses_{}", provider.as_str()),
            project_id: "prj_1".into(),
            worktree_id: None,
            preset_id: "pre_1".into(),
            title: "native backup".into(),
            cwd: "/workspace/demo".into(),
            host_pid: None,
            host_socket: None,
            host_token: "token".into(),
            lifecycle: Lifecycle::Stopped,
            agent_session_id: native_id.map(str::to_string),
            resume_precision: ResumePrecision::Exact,
            log_path: paths
                .root()
                .join("removed.log")
                .to_string_lossy()
                .into_owned(),
            adapter_type: provider,
            transport: AgentTransport::Pty,
            command: Vec::new(),
            permission_mode: PermissionMode::Native,
            pinned_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived_at: None,
        }
    }

    fn capture_with(
        temp: &TempDir,
        paths: &AppPaths,
        session: &Session,
        roots: &NativeRoots,
    ) -> NativeSessionBackup {
        let staging = temp.path().join("staging");
        fs::create_dir_all(&staging).unwrap();
        capture_session_with_roots(paths, session, &staging, roots).unwrap()
    }

    #[test]
    fn claude_capture_selects_only_matching_session_and_restores_idempotently() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        paths.ensure_layout().unwrap();
        let roots = roots(temp.path());
        let session = session(&paths, AgentType::Claude, Some("native-a"));
        let project = roots.claude.join("projects").join(cwd_slug(&session.cwd));
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("native-a.jsonl"), b"wanted\n").unwrap();
        fs::write(project.join("other.jsonl"), b"private\n").unwrap();
        let staging = temp.path().join("staging");
        fs::create_dir_all(&staging).unwrap();
        let captured = capture_session_with_roots(&paths, &session, &staging, &roots).unwrap();
        assert_eq!(captured.coverage, NativeCoverage::Complete);
        assert_eq!(captured.artifacts.len(), 1);
        assert!(!captured.artifacts[0].target_path.contains("other"));

        fs::remove_file(project.join("native-a.jsonl")).unwrap();
        let target = temp.path().join("restored-data");
        let report =
            materialize_with_roots(&staging, &target, &[captured.clone()], &roots).unwrap();
        assert_eq!(report.installed_files, 1);
        assert_eq!(
            fs::read(project.join("native-a.jsonl")).unwrap(),
            b"wanted\n"
        );
        let second = materialize_with_roots(&staging, &target, &[captured], &roots).unwrap();
        assert_eq!(second.reused_files, 1);
        assert_eq!(fs::read(project.join("other.jsonl")).unwrap(), b"private\n");
    }

    #[test]
    fn codex_multiple_id_matches_are_ambiguous() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        paths.ensure_layout().unwrap();
        let roots = roots(temp.path());
        let session = session(&paths, AgentType::Codex, Some("thread-a"));
        for leaf in ["2026/one.jsonl", "2026/two.jsonl"] {
            let path = roots.codex.join("sessions").join(leaf);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(
                path,
                format!(
                    "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"thread-a\",\"cwd\":\"{}\"}}}}\n",
                    session.cwd
                ),
            )
            .unwrap();
        }
        let captured = capture_with(&temp, &paths, &session, &roots);
        assert_eq!(captured.coverage, NativeCoverage::Ambiguous);
        assert!(captured.artifacts.is_empty());
    }

    #[test]
    fn pi_capture_restores_under_target_agentport_root() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        paths.ensure_layout().unwrap();
        let roots = roots(temp.path());
        let session = session(&paths, AgentType::Pi, Some("pi-native"));
        let transcript = paths.session_dir(&session.id).join("pi/pi-native.jsonl");
        fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        fs::write(&transcript, b"pi\n").unwrap();
        let staging = temp.path().join("staging");
        fs::create_dir_all(&staging).unwrap();
        let captured = capture_session_with_roots(&paths, &session, &staging, &roots).unwrap();
        let restored = temp.path().join("restored-data");
        materialize_with_roots(&staging, &restored, &[captured], &roots).unwrap();
        assert_eq!(
            fs::read(restored.join("sessions/ses_pi/pi/pi-native.jsonl")).unwrap(),
            b"pi\n"
        );
    }

    #[test]
    fn kimi_capture_restores_directory_and_index_binding() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        paths.ensure_layout().unwrap();
        let roots = roots(temp.path());
        let session = session(&paths, AgentType::Kimi, Some("session_kimi"));
        let session_dir = roots.kimi.join("sessions/session_kimi");
        fs::create_dir_all(session_dir.join("agents/main")).unwrap();
        fs::write(session_dir.join("agents/main/wire.jsonl"), b"kimi\n").unwrap();
        fs::write(
            roots.kimi.join("session_index.jsonl"),
            format!(
                "{{\"sessionId\":\"session_kimi\",\"workDir\":\"{}\",\"sessionDir\":\"{}\"}}\n",
                session.cwd,
                session_dir.display()
            ),
        )
        .unwrap();
        let staging = temp.path().join("staging");
        fs::create_dir_all(&staging).unwrap();
        let captured = capture_session_with_roots(&paths, &session, &staging, &roots).unwrap();
        fs::remove_dir_all(&roots.kimi).unwrap();
        let restored = temp.path().join("restored-data");
        let report = materialize_with_roots(&staging, &restored, &[captured], &roots).unwrap();
        assert_eq!(report.kimi_index_entries, 1);
        assert!(roots
            .kimi
            .join("sessions/session_kimi/agents/main/wire.jsonl")
            .is_file());
        let index = fs::read_to_string(roots.kimi.join("session_index.jsonl")).unwrap();
        assert!(index.contains("session_kimi"));
        assert!(index.contains(
            roots
                .kimi
                .join("sessions/session_kimi")
                .to_string_lossy()
                .as_ref()
        ));
    }

    #[test]
    fn qoder_capture_keeps_only_matching_id_directory() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        paths.ensure_layout().unwrap();
        let roots = roots(temp.path());
        let session = session(&paths, AgentType::Qoder, Some("qoder-a"));
        let project = roots
            .qoder
            .join("logs/sessions")
            .join(cwd_slug(&session.cwd));
        for id in ["qoder-a", "other"] {
            let path = project.join(id).join("segments/1.jsonl");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, id.as_bytes()).unwrap();
        }
        let captured = capture_with(&temp, &paths, &session, &roots);
        assert_eq!(captured.coverage, NativeCoverage::Complete);
        assert!(captured
            .artifacts
            .iter()
            .all(|artifact| artifact.target_path.contains("qoder-a")));
    }

    #[test]
    fn shell_and_missing_id_have_explicit_coverage() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        paths.ensure_layout().unwrap();
        let roots = roots(temp.path());
        let shell = capture_with(
            &temp,
            &paths,
            &session(&paths, AgentType::Shell, None),
            &roots,
        );
        assert_eq!(shell.coverage, NativeCoverage::Unsupported);
        let claude = capture_with(
            &temp,
            &paths,
            &session(&paths, AgentType::Claude, None),
            &roots,
        );
        assert_eq!(claude.coverage, NativeCoverage::Missing);
    }

    #[test]
    fn materialize_rejects_different_existing_content_without_overwrite() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        paths.ensure_layout().unwrap();
        let roots = roots(temp.path());
        let session = session(&paths, AgentType::Claude, Some("native-a"));
        let project = roots.claude.join("projects").join(cwd_slug(&session.cwd));
        fs::create_dir_all(&project).unwrap();
        let path = project.join("native-a.jsonl");
        fs::write(&path, b"backup\n").unwrap();
        let staging = temp.path().join("staging");
        fs::create_dir_all(&staging).unwrap();
        let captured = capture_session_with_roots(&paths, &session, &staging, &roots).unwrap();
        fs::write(&path, b"different\n").unwrap();
        let error = materialize_with_roots(
            &staging,
            &temp.path().join("restored-data"),
            &[captured],
            &roots,
        )
        .unwrap_err();
        assert!(error.to_string().contains("overwrite different content"));
        assert_eq!(fs::read(&path).unwrap(), b"different\n");
    }
}
