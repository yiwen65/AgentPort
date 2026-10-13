//! Read-only file access rooted in the server-recorded Session cwd.
//!
//! Canonicalization handles aliases and enforces component containment. It is
//! NOT the open primitive: every subsequent component is opened relative to a
//! pinned directory descriptor with NOFOLLOW. Replacing a checked component
//! with a symlink cannot redirect the read. Listing also uses the descriptor.

use serde::Deserialize;
use std::io;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

#[path = "session_file_downloads.rs"]
pub(crate) mod downloads;

const MAX_BYTES: usize = 1024 * 1024;
const MAX_ENTRIES: usize = 2_000;
const MAX_SCANNED_ENTRIES: usize = 16_000;

#[cfg(all(test, unix))]
#[path = "session_files_tests.rs"]
mod tests;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SessionFilesError {
    #[error("The requested path is outside this Session's project directory.")]
    OutsideRoot,
    #[error("Only regular files are supported; previews require UTF-8 text.")]
    UnsupportedFile,
    #[error("The requested path does not exist.")]
    PathNotFound,
    #[error("The service account does not have permission to access this path.")]
    PermissionDenied,
    #[error("The requested path is not a directory.")]
    NotDirectory,
    #[error("Provide a valid relative path within this Session's project directory.")]
    InvalidPath,
    #[error("The requested path could not be read.")]
    ReadFailed,
    #[error("The Session no longer exists on this computer.")]
    SessionNotFound,
    #[error("Secure Session file browsing is not supported on this computer's platform.")]
    UnsupportedPlatform,
    #[error("The file exceeds the 1 GiB download limit.")]
    FileTooLarge,
    #[error("The image exceeds the 20 MiB image limit.")]
    ImageTooLarge,
    #[error("The source file changed during download. Retry from the beginning.")]
    SourceChanged,
    #[error("This download is invalid, expired, or belongs to another connection.")]
    InvalidDownload,
    #[error("The download offset must match the next unread byte.")]
    InvalidOffset,
    #[error("The download has not transferred all of its bytes.")]
    IncompleteDownload,
    #[error("Too many downloads are open on this connection.")]
    TooManyDownloads,
}

impl SessionFilesError {
    pub fn code(self) -> &'static str {
        match self {
            Self::OutsideRoot => "outside_root",
            Self::UnsupportedFile => "unsupported_file",
            Self::PathNotFound => "path_not_found",
            Self::PermissionDenied => "permission_denied",
            Self::NotDirectory => "not_directory",
            Self::InvalidPath => "invalid_path",
            Self::ReadFailed => "read_failed",
            Self::SessionNotFound => "session_not_found",
            Self::UnsupportedPlatform => "unsupported_platform",
            Self::FileTooLarge | Self::ImageTooLarge => "file_too_large",
            Self::SourceChanged => "source_changed",
            Self::InvalidDownload => "invalid_download",
            Self::InvalidOffset => "invalid_offset",
            Self::IncompleteDownload => "incomplete_download",
            Self::TooManyDownloads => "too_many_downloads",
        }
    }
}

type Result<T> = std::result::Result<T, SessionFilesError>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Params {
    pub session_id: String,
    pub path: Option<String>,
}

fn io_error(error: io::Error) -> SessionFilesError {
    match error.kind() {
        io::ErrorKind::NotFound => SessionFilesError::PathNotFound,
        io::ErrorKind::PermissionDenied => SessionFilesError::PermissionDenied,
        io::ErrorKind::InvalidInput => SessionFilesError::InvalidPath,
        _ => {
            #[cfg(unix)]
            match error.raw_os_error() {
                Some(code) if code == rustix::io::Errno::NOTDIR.raw_os_error() => {
                    return SessionFilesError::NotDirectory;
                }
                Some(code) if code == rustix::io::Errno::LOOP.raw_os_error() => {
                    return SessionFilesError::OutsideRoot;
                }
                _ => {}
            }
            SessionFilesError::ReadFailed
        }
    }
}

fn relative_path(path: &str) -> Result<PathBuf> {
    // Backslashes/drive prefixes are rejected on every host for an unambiguous
    // slash-separated wire contract, even though Unix permits such filenames.
    if path.is_empty() || path.contains(['\0', '\\']) || path.contains(':') {
        return Err(SessionFilesError::InvalidPath);
    }
    let path = Path::new(path);
    if path.is_absolute() {
        return Err(SessionFilesError::InvalidPath);
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(name) => normalized.push(name),
            Component::CurDir => {}
            Component::ParentDir => return Err(SessionFilesError::OutsideRoot),
            _ => return Err(SessionFilesError::InvalidPath),
        }
    }
    Ok(normalized)
}

fn wire_path(path: &Path) -> Result<String> {
    if path.as_os_str().is_empty() {
        return Ok(".".into());
    }
    path.to_str()
        .map(str::to_owned)
        .ok_or(SessionFilesError::InvalidPath)
}

pub(crate) fn execute(cwd: &str, path: Option<&str>, list: bool) -> Result<serde_json::Value> {
    let path = match path {
        Some(path) => path,
        None if list => ".",
        None => return Err(SessionFilesError::InvalidPath),
    };
    let relative = relative_path(path)?;
    #[cfg(unix)]
    {
        secure::execute(cwd, &relative, list)
    }
    #[cfg(not(unix))]
    {
        // Do not fall back to check-then-reopen on unsupported platforms.
        let _ = (cwd, relative, list);
        Err(SessionFilesError::UnsupportedPlatform)
    }
}

#[cfg(unix)]
mod secure {
    use super::*;
    use rustix::fs::{open, openat, statat, AtFlags, Dir, FileType, Mode, OFlags};
    use std::fs::File;
    use std::io::Read;

    fn flags(directory: bool) -> OFlags {
        let flags =
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY;
        if directory {
            flags | OFlags::DIRECTORY
        } else {
            flags
        }
    }

    fn open_child(parent: &File, name: &Path, directory: bool) -> Result<File> {
        // Avoid even opening a known device/FIFO/socket. NOFOLLOW and the
        // descriptor metadata check below remain authoritative after this hint.
        let stat = statat(parent, name, AtFlags::SYMLINK_NOFOLLOW)
            .map_err(|error| io_error(error.into()))?;
        match FileType::from_raw_mode(stat.st_mode) {
            FileType::Symlink => return Err(SessionFilesError::OutsideRoot),
            FileType::Directory => {}
            FileType::RegularFile if !directory => {}
            _ if directory => return Err(SessionFilesError::NotDirectory),
            _ => return Err(SessionFilesError::UnsupportedFile),
        }
        openat(parent, name, flags(directory), Mode::empty())
            .map(File::from)
            .map_err(|error| io_error(error.into()))
    }

    struct Root {
        canonical: PathBuf,
        directory: File,
    }

    impl Root {
        fn new(cwd: &str) -> Result<Self> {
            if !Path::new(cwd).is_absolute() {
                return Err(SessionFilesError::InvalidPath);
            }
            let canonical = std::fs::canonicalize(cwd).map_err(io_error)?;
            let mut directory = File::from(
                open("/", flags(true), Mode::empty()).map_err(|error| io_error(error.into()))?,
            );
            // Pin the root too: NOFOLLOW on just the final component would not
            // protect a swapped ancestor of the Session cwd.
            for component in canonical.components() {
                if let Component::Normal(name) = component {
                    directory = open_child(&directory, Path::new(name), true)?;
                }
            }
            Ok(Self {
                canonical,
                directory,
            })
        }

        fn canonical_relative(&self, relative: &Path) -> Result<PathBuf> {
            let target = std::fs::canonicalize(self.canonical.join(relative)).map_err(io_error)?;
            target
                .strip_prefix(&self.canonical)
                .map(Path::to_path_buf)
                .map_err(|_| SessionFilesError::OutsideRoot)
        }

        fn open_relative(&self, relative: &Path, directory: bool) -> Result<File> {
            let components = relative.components().collect::<Vec<_>>();
            let mut file = self.directory.try_clone().map_err(io_error)?;
            for (index, component) in components.iter().enumerate() {
                let Component::Normal(name) = component else {
                    return Err(SessionFilesError::InvalidPath);
                };
                file = open_child(
                    &file,
                    Path::new(name),
                    directory || index + 1 < components.len(),
                )?;
            }
            let metadata = file.metadata().map_err(io_error)?;
            if directory && !metadata.is_dir() {
                return Err(SessionFilesError::NotDirectory);
            }
            if !directory && !metadata.is_file() {
                return Err(SessionFilesError::UnsupportedFile);
            }
            Ok(file)
        }

        fn open(&self, relative: &Path, directory: bool) -> Result<File> {
            let canonical = self.canonical_relative(relative)?;
            self.open_relative(&canonical, directory)
        }
    }

    pub(super) fn open_download(cwd: &str, relative: &Path) -> Result<(File, File)> {
        let root = Root::new(cwd)?;
        let file = root.open(relative, false)?;
        Ok((file, root.directory))
    }

    pub(super) fn execute(cwd: &str, relative: &Path, list: bool) -> Result<serde_json::Value> {
        let root = Root::new(cwd)?;
        let file = root.open(relative, list)?;
        let root_path = root
            .canonical
            .to_str()
            .ok_or(SessionFilesError::InvalidPath)?;
        let path = wire_path(relative)?;
        if list {
            let directory = Dir::read_from(&file).map_err(|error| io_error(error.into()))?;
            let mut entries = Vec::new();
            let mut truncated = false;
            for (index, entry) in directory.enumerate() {
                if index == MAX_SCANNED_ENTRIES {
                    truncated = true;
                    break;
                }
                let entry = entry.map_err(|error| io_error(error.into()))?;
                let Ok(name) = entry.file_name().to_str() else {
                    truncated = true;
                    continue;
                };
                if matches!(name, "." | ".." | ".git") {
                    continue;
                }
                let entry_path = relative.join(name);
                // Don't return paths the wire protocol cannot round-trip.
                if relative_path(&wire_path(&entry_path)?).is_err() {
                    truncated = true;
                    continue;
                }
                let is_dir = match entry.file_type() {
                    FileType::Directory => true,
                    FileType::RegularFile => false,
                    FileType::Symlink | FileType::Unknown => {
                        // Resolve aliases only inside the root; omit escaping,
                        // dangling and special-file links without leaking targets.
                        if root.open(&entry_path, true).is_ok() {
                            true
                        } else if root.open(&entry_path, false).is_ok() {
                            false
                        } else {
                            continue;
                        }
                    }
                    _ => continue,
                };
                if entries.len() == MAX_ENTRIES {
                    truncated = true;
                    break;
                }
                entries.push((is_dir, name.to_owned(), wire_path(&entry_path)?));
            }
            entries.sort_by(|left, right| {
                right
                    .0
                    .cmp(&left.0)
                    .then_with(|| left.1.to_lowercase().cmp(&right.1.to_lowercase()))
                    .then_with(|| left.1.cmp(&right.1))
            });
            let entries = entries.into_iter().map(|(is_dir, name, path)| {
                serde_json::json!({"name": name, "path": path, "isDir": is_dir})
            }).collect::<Vec<_>>();
            Ok(
                serde_json::json!({"rootPath": root_path, "path": path, "entries": entries, "truncated": truncated}),
            )
        } else {
            let size = file.metadata().map_err(io_error)?.len();
            let mut bytes = Vec::new();
            file.take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            let truncated = bytes.len() > MAX_BYTES || size > MAX_BYTES as u64;
            bytes.truncate(MAX_BYTES);
            if bytes
                .iter()
                .any(|byte| *byte < 32 && !matches!(byte, b'\t' | b'\n' | b'\r'))
            {
                return Err(SessionFilesError::UnsupportedFile);
            }
            // A truncation boundary may split a UTF-8 scalar; omit just that
            // incomplete scalar, never replace malformed/binary bytes silently.
            let content = match std::str::from_utf8(&bytes) {
                Ok(text) => text,
                Err(error) if truncated && error.error_len().is_none() => {
                    std::str::from_utf8(&bytes[..error.valid_up_to()])
                        .map_err(|_| SessionFilesError::UnsupportedFile)?
                }
                Err(_) => return Err(SessionFilesError::UnsupportedFile),
            };
            Ok(
                serde_json::json!({"rootPath": root_path, "path": path, "content": content, "sizeBytes": size, "truncated": truncated}),
            )
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;

        #[test]
        fn pinned_directory_listing_survives_path_replacement_without_following_it() {
            let parent = tempfile::tempdir().unwrap();
            let cwd = parent.path().join("root");
            let outside = parent.path().join("outside");
            std::fs::create_dir(&cwd).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(cwd.join("inside"), "safe").unwrap();
            std::fs::write(outside.join("SECRET"), "secret").unwrap();
            let root = Root::new(cwd.to_str().unwrap()).unwrap();
            let pinned = root.open(Path::new(""), true).unwrap();
            std::fs::rename(&cwd, parent.path().join("old-root")).unwrap();
            symlink(&outside, &cwd).unwrap();
            let mut names = Dir::read_from(&pinned)
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_owned())
                .filter(|name| name != "." && name != "..")
                .collect::<Vec<_>>();
            names.sort();
            assert_eq!(names, ["inside"]);
            let mut content = String::new();
            root.open_relative(Path::new("inside"), false)
                .unwrap()
                .read_to_string(&mut content)
                .unwrap();
            assert_eq!(content, "safe");
        }

        #[test]
        fn symlink_swap_after_canonical_check_cannot_redirect_open() {
            let root_dir = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            std::fs::write(root_dir.path().join("note"), "inside").unwrap();
            std::fs::write(outside.path().join("note"), "SECRET").unwrap();
            let root = Root::new(root_dir.path().to_str().unwrap()).unwrap();
            let checked = root.canonical_relative(Path::new("note")).unwrap();
            std::fs::remove_file(root_dir.path().join("note")).unwrap();
            symlink(outside.path().join("note"), root_dir.path().join("note")).unwrap();
            assert_eq!(
                root.open_relative(&checked, false).unwrap_err(),
                SessionFilesError::OutsideRoot
            );

            std::fs::create_dir(root_dir.path().join("sub")).unwrap();
            std::fs::write(root_dir.path().join("sub/note"), "inside").unwrap();
            let checked = root.canonical_relative(Path::new("sub/note")).unwrap();
            std::fs::rename(root_dir.path().join("sub"), root_dir.path().join("old-sub")).unwrap();
            symlink(outside.path(), root_dir.path().join("sub")).unwrap();
            assert!(root.open_relative(&checked, false).is_err());
        }
    }
}
