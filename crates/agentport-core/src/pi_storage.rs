//! Managed Pi storage under easy-pi's sessions root. Only explicit cold launch
//! or resume may migrate; readers never copy or delete native data.
use crate::{
    adapters::LaunchPlan,
    error::{CoreError, Result},
    paths::AppPaths,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

pub(crate) const ORIGIN: &str = ".agentport-origin.json";
const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: PathBuf,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Origin {
    version: u32,
    source: PathBuf,
    files: Vec<Entry>,
}

fn conflict(message: &str) -> CoreError {
    CoreError::Conflict(message.into())
}

fn addresses(paths: &AppPaths, id: &str) -> Result<(PathBuf, PathBuf)> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(CoreError::Validation("invalid AgentPort session ID".into()));
    }
    let directory = paths.session_dir(id);
    if !directory.is_absolute() {
        return Err(CoreError::Validation(
            "session directory must be absolute".into(),
        ));
    }
    let directory = directory.canonicalize().unwrap_or(directory);
    let source = directory.join("pi");
    let key = format!("{:x}", Sha256::digest(source.to_string_lossy().as_bytes()));
    Ok((
        source,
        paths
            .pi_sessions_root()?
            .join(format!("--agentport-{key}--")),
    ))
}

fn regular(path: &Path) -> Result<fs::Metadata> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(conflict("unsafe Pi storage file"));
    }
    Ok(metadata)
}

fn private_directory(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(conflict("unsafe Pi storage directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = path.parent() {
                private_directory(parent)?;
            }
            fs::DirBuilder::new().mode(0o700).create(path)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn digest(path: &Path) -> Result<(u64, String)> {
    let before = regular(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?
        .take(before.len().saturating_add(1));
    let mut hash = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        bytes += read as u64;
    }
    let after = regular(path)?;
    if before.len() != bytes || after.len() != bytes || before.modified()? != after.modified()? {
        return Err(conflict("Pi source changed while being read"));
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

fn inventory(root: &Path) -> Result<Vec<Entry>> {
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(conflict("unsafe Pi source directory"))
        }
        Ok(_) => {}
    }
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut directories = 0;
    while let Some(directory) = stack.pop() {
        directories += 1;
        if directories > MAX_FILES {
            return Err(conflict("too many Pi support directories"));
        }
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                return Err(conflict("Pi migration refuses symlinks"));
            }
            if kind.is_dir() {
                stack.push(path);
            } else if kind.is_file() {
                if files.len() >= MAX_FILES {
                    return Err(conflict("too many Pi support files"));
                }
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| conflict("invalid Pi source path"))?
                    .to_path_buf();
                if relative == Path::new(ORIGIN) {
                    return Err(conflict("reserved Pi migration marker in source"));
                }
                let (bytes, sha256) = digest(&path)?;
                files.push(Entry {
                    path: relative,
                    bytes,
                    sha256,
                });
            } else {
                return Err(conflict("Pi migration refuses special files"));
            }
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}

fn origin(target: &Path, source: &Path) -> Result<Origin> {
    let metadata = fs::symlink_metadata(target)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(conflict("unsafe Pi target directory"));
    }
    let marker = target.join(ORIGIN);
    if regular(&marker)?.len() > 16 * 1024 * 1024 {
        return Err(conflict("oversized Pi origin marker"));
    }
    let value: Origin = serde_json::from_reader(
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(marker)?,
    )?;
    if value.version != 1
        || value.source != source
        || value.files.len() > MAX_FILES
        || value.files.iter().any(|entry| {
            entry.path.as_os_str().is_empty()
                || !entry
                    .path
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
        })
    {
        return Err(conflict("unknown or mismatched Pi storage origin"));
    }
    Ok(value)
}

/// Unpublished partial copies do not replace readable legacy history.
/// A malformed published marker is an error, never permission to select another copy.
pub fn read_directory(paths: &AppPaths, id: &str) -> Result<PathBuf> {
    let (source, target) = addresses(paths, id)?;
    match fs::symlink_metadata(target.join(ORIGIN)) {
        Ok(_) => {
            origin(&target, &source)?;
            Ok(target)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(source),
        Err(error) => Err(error.into()),
    }
}

/// Retain the entire original directory. The origin marker is the commit point;
/// interrupted staging remains unowned and cannot be silently reused/overwritten.
pub fn prepare_launch(paths: &AppPaths, id: &str, plan: &mut LaunchPlan) -> Result<()> {
    let positions = plan
        .argv
        .iter()
        .enumerate()
        .filter_map(|(index, arg)| (arg == "--session-dir").then_some(index))
        .collect::<Vec<_>>();
    if positions.len() != 1
        || plan.argv.get(positions[0] + 1).map(Path::new)
            != Some(paths.session_dir(id).join("pi").as_path())
    {
        return Err(conflict("unexpected Pi session storage arguments"));
    }
    private_directory(&paths.session_dir(id))?;
    let (source, target) = addresses(paths, id)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(paths.session_dir(id).join(".pi-storage.lock"))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(conflict("Pi storage migration is busy"));
    }
    if fs::symlink_metadata(&target).is_ok() {
        let previous = origin(&target, &source)?;
        for entry in &previous.files {
            if entry.path.parent() == Some(Path::new(""))
                && entry.path.extension().is_some_and(|ext| ext == "jsonl")
            {
                regular(&target.join(&entry.path))?;
            }
        }
        if source.exists() && inventory(&source)? != previous.files {
            return Err(conflict(
                "retained legacy Pi history changed; resolve the divergence before resume",
            ));
        }
    } else {
        let before = inventory(&source)?;
        let native_id = plan
            .argv
            .windows(2)
            .find(|pair| pair[0] == "--session-id")
            .map(|pair| pair[1].as_str())
            .ok_or_else(|| conflict("missing exact Pi session ID"))?;
        let mut headers = Vec::new();
        for entry in &before {
            if entry.path.parent() == Some(Path::new(""))
                && entry.path.extension().is_some_and(|ext| ext == "jsonl")
            {
                let file = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW)
                    .open(source.join(&entry.path))?;
                let mut header = String::new();
                BufReader::new(file.take(65537)).read_line(&mut header)?;
                if header.len() > 65536 {
                    return Err(conflict("oversized Pi session header"));
                }
                let header: serde_json::Value = serde_json::from_str(&header)?;
                if header["type"] != "session"
                    || !matches!(header["version"].as_u64(), Some(1..=3))
                    || header["id"].as_str().is_none()
                {
                    return Err(conflict(
                        "unknown Pi session format; legacy history was not migrated",
                    ));
                }
                headers.push(header["id"].as_str().unwrap().to_string());
            }
        }
        if !headers.is_empty() && headers.iter().filter(|id| *id == native_id).count() != 1 {
            return Err(conflict(
                "Pi native session ID is missing or ambiguous in retained history",
            ));
        }
        private_directory(
            target
                .parent()
                .ok_or_else(|| conflict("missing Pi storage parent"))?,
        )?;
        fs::DirBuilder::new().mode(0o700).create(&target)?; // exclusive ownership; never overwrite an existing target
        for entry in &before {
            let destination = target.join(&entry.path);
            private_directory(
                destination
                    .parent()
                    .ok_or_else(|| conflict("invalid Pi support path"))?,
            )?;
            let mut reader = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW)
                .open(source.join(&entry.path))?
                .take(entry.bytes.saturating_add(1));
            let mut writer = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&destination)?;
            std::io::copy(&mut reader, &mut writer)?;
            writer.sync_all()?;
            if digest(&destination)? != (entry.bytes, entry.sha256.clone()) {
                return Err(conflict("Pi source changed during migration"));
            }
        }
        if inventory(&source)? != before {
            return Err(conflict("Pi source changed before publication"));
        }
        let value = Origin {
            version: 1,
            source: source.clone(),
            files: before,
        };
        let staging = target.join(".origin-pending");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staging)?;
        file.write_all(&serde_json::to_vec(&value)?)?;
        file.sync_all()?;
        fs::hard_link(&staging, target.join(ORIGIN))?;
        fs::remove_file(staging)?;
        File::open(&target)?.sync_all()?;
        File::open(target.parent().unwrap())?.sync_all()?;
    }
    plan.argv[positions[0] + 1] = target.to_string_lossy().into_owned();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentTransport, HookStatus, ResumePrecision};
    use tempfile::TempDir;

    fn fixture() -> (TempDir, AppPaths) {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("app"))
            .with_pi_sessions_root(temp.path().join(".epi/agent/sessions"));
        paths.ensure_layout().unwrap();
        private_directory(&paths.session_dir("ses_one")).unwrap();
        (temp, paths)
    }
    fn plan(paths: &AppPaths) -> LaunchPlan {
        LaunchPlan {
            argv: vec![
                "pi".into(),
                "--session-id".into(),
                "native-id".into(),
                "--session-dir".into(),
                paths
                    .session_dir("ses_one")
                    .join("pi")
                    .to_string_lossy()
                    .into_owned(),
            ],
            env: vec![],
            assigned_agent_session_id: Some("native-id".into()),
            resume_precision: ResumePrecision::Exact,
            hook_status: HookStatus::Unavailable,
            transport: AgentTransport::Pty,
            helper_files: vec![],
            notices: vec![],
        }
    }
    fn legacy(paths: &AppPaths) -> PathBuf {
        let source = paths.session_dir("ses_one").join("pi");
        fs::create_dir_all(source.join("support/nested")).unwrap();
        fs::write(source.join("2026_native-id.jsonl"), b"{\"type\":\"session\",\"version\":3,\"id\":\"native-id\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"old question\"}}\n").unwrap();
        fs::write(source.join("support/nested/blob"), [0u8, 1, 254]).unwrap();
        source
    }

    #[test]
    fn new_launch_uses_epi_and_keeps_native_identity() {
        let (_temp, paths) = fixture();
        let mut launch = plan(&paths);
        prepare_launch(&paths, "ses_one", &mut launch).unwrap();
        let target = read_directory(&paths, "ses_one").unwrap();
        assert!(target.starts_with(paths.pi_sessions_root().unwrap()));
        assert_eq!(launch.argv[4], target.to_string_lossy());
        assert_eq!(launch.argv[2], "native-id");
        assert_eq!(
            launch.assigned_agent_session_id.as_deref(),
            Some("native-id")
        );
        assert!(!paths.session_dir("ses_one").join("pi").exists());
        assert!(target.join(ORIGIN).is_file());
    }

    #[test]
    fn migration_preserves_bytes_and_repeat_resume_never_overwrites_new_history() {
        let (_temp, paths) = fixture();
        let source = legacy(&paths);
        let before = inventory(&source).unwrap();
        assert_eq!(
            read_directory(&paths, "ses_one").unwrap(),
            source.canonicalize().unwrap()
        );
        prepare_launch(&paths, "ses_one", &mut plan(&paths)).unwrap();
        let target = read_directory(&paths, "ses_one").unwrap();
        for entry in &before {
            assert_eq!(
                digest(&target.join(&entry.path)).unwrap(),
                (entry.bytes, entry.sha256.clone())
            );
        }
        assert_eq!(inventory(&source).unwrap(), before);
        let file = target.join("2026_native-id.jsonl");
        OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(b"new turn\n")
            .unwrap();
        prepare_launch(&paths, "ses_one", &mut plan(&paths)).unwrap();
        assert!(fs::read_to_string(file).unwrap().ends_with("new turn\n"));
        assert_eq!(inventory(&source).unwrap(), before);
    }

    #[test]
    fn divergent_legacy_copy_blocks_resume_but_readers_keep_the_published_history() {
        let (_temp, paths) = fixture();
        let source = legacy(&paths);
        prepare_launch(&paths, "ses_one", &mut plan(&paths)).unwrap();
        let target = read_directory(&paths, "ses_one").unwrap();
        fs::write(source.join("support/nested/blob"), b"old host changed this").unwrap();
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths))
            .unwrap_err()
            .to_string()
            .contains("divergence"));
        assert_eq!(read_directory(&paths, "ses_one").unwrap(), target);
        assert_eq!(
            fs::read(target.join("support/nested/blob")).unwrap(),
            [0u8, 1, 254]
        );
    }

    #[test]
    fn unowned_or_partial_target_is_never_overwritten_or_used_for_history() {
        let (_temp, paths) = fixture();
        let source = legacy(&paths);
        let (_, target) = addresses(&paths, "ses_one").unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("sentinel"), b"retain").unwrap();
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths)).is_err());
        assert_eq!(fs::read(target.join("sentinel")).unwrap(), b"retain");
        assert_eq!(
            read_directory(&paths, "ses_one").unwrap(),
            source.canonicalize().unwrap()
        );
    }

    #[test]
    fn symlinks_unknown_formats_and_wrong_native_ids_fail_before_publication() {
        let (_temp, paths) = fixture();
        let source = legacy(&paths);
        let link = source.join("link");
        std::os::unix::fs::symlink(source.join("support/nested/blob"), &link).unwrap();
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths)).is_err());
        fs::remove_file(link).unwrap();
        let primary = source.join("2026_native-id.jsonl");
        fs::write(
            &primary,
            b"{\"type\":\"session\",\"version\":99,\"id\":\"native-id\"}\n",
        )
        .unwrap();
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths)).is_err());
        fs::write(
            &primary,
            b"{\"type\":\"session\",\"version\":3,\"id\":\"other-id\"}\n",
        )
        .unwrap();
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths)).is_err());
        assert!(!addresses(&paths, "ses_one").unwrap().1.exists());
    }

    #[test]
    fn duplicate_native_primary_ids_are_rejected_before_copy() {
        let (_temp, paths) = fixture();
        let source = legacy(&paths);
        fs::copy(
            source.join("2026_native-id.jsonl"),
            source.join("duplicate.jsonl"),
        )
        .unwrap();
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths)).is_err());
        assert!(!addresses(&paths, "ses_one").unwrap().1.exists());
    }

    #[test]
    fn damaged_marker_or_missing_migrated_primary_never_falls_back_to_the_old_copy() {
        let (_temp, paths) = fixture();
        legacy(&paths);
        prepare_launch(&paths, "ses_one", &mut plan(&paths)).unwrap();
        let target = read_directory(&paths, "ses_one").unwrap();
        fs::remove_file(target.join("2026_native-id.jsonl")).unwrap();
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths)).is_err());
        fs::write(target.join(ORIGIN), b"{\"version\":99}").unwrap();
        assert!(read_directory(&paths, "ses_one").is_err());
        assert!(prepare_launch(&paths, "ses_one", &mut plan(&paths)).is_err());
    }
}
