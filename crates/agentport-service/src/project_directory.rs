//! Read-only directory discovery under the remote service account's permissions.

use crate::{ProjectDirectoryEntry, ProjectDirectoryListResult};
use agentport_remote_protocol::ProjectDirectoryListParams;
use std::io;
use std::path::{Path, PathBuf};
use thiserror::Error;

const MAX_ENTRIES: usize = 512;
const MAX_SCANNED_ENTRIES: usize = 4_096;

/// Only these bounded, public failures may cross the Bridge. Never forward an
/// arbitrary filesystem error string (which can contain internal host details).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum ProjectDirectoryError {
    #[error("The path does not exist on this computer.")]
    PathNotFound,
    #[error("The path is not a directory.")]
    NotDirectory,
    #[error("The service account does not have permission to access this directory.")]
    PermissionDenied,
    #[error("Enter a valid absolute directory path on this computer.")]
    InvalidPath,
    #[error("The directory could not be read on this computer.")]
    DirectoryReadFailed,
}

impl ProjectDirectoryError {
    pub fn code(self) -> &'static str {
        match self {
            Self::PathNotFound => "path_not_found",
            Self::NotDirectory => "not_directory",
            Self::PermissionDenied => "permission_denied",
            Self::InvalidPath => "invalid_path",
            Self::DirectoryReadFailed => "directory_read_failed",
        }
    }
}

fn io_error(error: io::Error) -> ProjectDirectoryError {
    match error.kind() {
        io::ErrorKind::NotFound => ProjectDirectoryError::PathNotFound,
        io::ErrorKind::PermissionDenied => ProjectDirectoryError::PermissionDenied,
        io::ErrorKind::InvalidInput => ProjectDirectoryError::InvalidPath,
        // ErrorKind::NotADirectory requires Rust 1.83; preserve our Rust 1.80
        // minimum using ENOTDIR / Windows ERROR_DIRECTORY on supported targets.
        _ if cfg!(unix) && error.raw_os_error() == Some(20)
            || cfg!(windows) && error.raw_os_error() == Some(267) =>
        {
            ProjectDirectoryError::NotDirectory
        }
        _ => ProjectDirectoryError::DirectoryReadFailed,
    }
}

pub(crate) fn resolve(path: &str) -> Result<String, ProjectDirectoryError> {
    if path.is_empty() || path.contains('\0') || !Path::new(path).is_absolute() {
        return Err(ProjectDirectoryError::InvalidPath);
    }
    let path = std::fs::canonicalize(path).map_err(io_error)?;
    if !std::fs::metadata(&path).map_err(io_error)?.is_dir() {
        return Err(ProjectDirectoryError::NotDirectory);
    }
    path.into_os_string()
        .into_string()
        .map_err(|_| ProjectDirectoryError::InvalidPath)
}

#[allow(deprecated)]
fn account_home() -> Result<PathBuf, ProjectDirectoryError> {
    // std uses this service process's HOME/USERPROFILE, with the Unix account
    // database fallback. It never derives Home from the app DB or mobile client.
    std::env::home_dir().ok_or(ProjectDirectoryError::DirectoryReadFailed)
}

pub(crate) fn list(
    params: ProjectDirectoryListParams,
) -> Result<ProjectDirectoryListResult, ProjectDirectoryError> {
    let home = account_home()?;
    list_with_home(params, &home)
}

fn list_with_home(
    params: ProjectDirectoryListParams,
    home: &Path,
) -> Result<ProjectDirectoryListResult, ProjectDirectoryError> {
    let home_path = resolve(home.to_str().ok_or(ProjectDirectoryError::InvalidPath)?)?;
    let path = match params.path {
        Some(path) => resolve(&path)?,
        None => home_path.clone(),
    };
    let directory = std::fs::read_dir(&path).map_err(io_error)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    // Bound both response size and scan work: a directory containing millions
    // of files must not monopolize this connection even if none are folders.
    for (index, entry) in directory.enumerate() {
        if index == MAX_SCANNED_ENTRIES {
            truncated = true;
            break;
        }
        let entry = entry.map_err(io_error)?;
        let file_type = entry.file_type().map_err(io_error)?;
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }
        let entry_name = entry.file_name();
        let Some(name) = entry_name.to_str() else {
            truncated = true;
            continue;
        };
        if !params.show_hidden && name.starts_with('.') {
            continue;
        }
        #[cfg(windows)]
        if !params.show_hidden {
            use std::os::windows::fs::MetadataExt;
            // FILE_ATTRIBUTE_HIDDEN also hides non-dot folders on Windows.
            if entry.metadata().map_err(io_error)?.file_attributes() & 0x2 != 0 {
                continue;
            }
        }
        let entry_path = entry.path();
        let Some(entry_path) = entry_path.to_str() else {
            truncated = true;
            continue;
        };
        // Follow symlinks, but omit dangling links, file links and directories
        // that cannot be resolved under this account's normal permissions.
        if resolve(entry_path).is_err() {
            continue;
        }
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(ProjectDirectoryEntry {
            name: name.into(),
            // Preserve the absolute alias path so distinct directory names
            // remain distinct rows. Resolve/add canonicalize it when selected.
            path: entry_path.into(),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name).then(left.path.cmp(&right.path)));
    let parent_path = Path::new(&path)
        .parent()
        .map(|parent| parent.to_string_lossy().into_owned());
    Ok(ProjectDirectoryListResult {
        path,
        home_path,
        parent_path,
        entries,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listing_defaults_to_home_filters_files_and_hidden_and_has_no_side_effects() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("ordinary")).unwrap();
        std::fs::create_dir(home.path().join(".hidden")).unwrap();
        std::fs::write(home.path().join("file.txt"), "unchanged").unwrap();
        let before = std::fs::read_dir(home.path()).unwrap().count();
        let visible = list_with_home(ProjectDirectoryListParams::default(), home.path()).unwrap();
        assert_eq!(
            visible.path,
            resolve(home.path().to_str().unwrap()).unwrap()
        );
        assert_eq!(visible.home_path, visible.path);
        assert_eq!(visible.entries.len(), 1);
        assert_eq!(visible.entries[0].name, "ordinary");
        assert_eq!(
            visible.parent_path,
            Path::new(&visible.path)
                .parent()
                .map(|p| p.to_str().unwrap().into())
        );
        assert!(!visible.truncated);
        let all = list_with_home(
            ProjectDirectoryListParams {
                show_hidden: true,
                ..Default::default()
            },
            home.path(),
        )
        .unwrap();
        assert_eq!(
            all.entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            [".hidden", "ordinary"]
        );
        assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), before);
        assert_eq!(
            std::fs::read_to_string(home.path().join("file.txt")).unwrap(),
            "unchanged"
        );
    }

    #[test]
    fn listing_handles_empty_directory_root_and_bounded_results() {
        let root = tempfile::tempdir().unwrap();
        let empty = list_with_home(ProjectDirectoryListParams::default(), root.path()).unwrap();
        assert!(empty.entries.is_empty());
        assert!(!empty.truncated);
        for index in 0..=MAX_ENTRIES {
            std::fs::create_dir(root.path().join(format!("directory-{index:04}"))).unwrap();
        }
        let bounded = list_with_home(ProjectDirectoryListParams::default(), root.path()).unwrap();
        assert_eq!(bounded.entries.len(), MAX_ENTRIES);
        assert!(bounded.truncated);
        #[cfg(unix)]
        {
            let filesystem_root = list_with_home(
                ProjectDirectoryListParams {
                    path: Some("/".into()),
                    show_hidden: false,
                },
                root.path(),
            )
            .unwrap();
            assert_eq!(filesystem_root.path, "/");
            assert_eq!(filesystem_root.parent_path, None);
        }
    }

    #[test]
    fn scan_work_is_bounded_even_when_there_are_only_files() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..=MAX_SCANNED_ENTRIES {
            std::fs::write(root.path().join(format!("file-{index}")), "").unwrap();
        }
        let bounded = list_with_home(ProjectDirectoryListParams::default(), root.path()).unwrap();
        assert!(bounded.entries.is_empty());
        assert!(bounded.truncated);
    }

    #[test]
    fn resolve_requires_an_existing_absolute_directory() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("file");
        std::fs::write(&file, "").unwrap();
        for path in ["", ".", "relative/path", "~/projects", "/invalid\0path"] {
            assert_eq!(resolve(path), Err(ProjectDirectoryError::InvalidPath));
        }
        assert_eq!(
            resolve(root.path().join("missing").to_str().unwrap()),
            Err(ProjectDirectoryError::PathNotFound)
        );
        assert_eq!(
            resolve(file.to_str().unwrap()),
            Err(ProjectDirectoryError::NotDirectory)
        );
        assert_eq!(
            resolve(file.join("child").to_str().unwrap()),
            Err(ProjectDirectoryError::NotDirectory)
        );
        assert_eq!(
            resolve(root.path().join(".").to_str().unwrap()).unwrap(),
            root.path().canonicalize().unwrap().to_str().unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlinks_are_resolved_and_non_directory_links_are_omitted() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("target")).unwrap();
        std::fs::write(root.path().join("file"), "").unwrap();
        symlink(root.path().join("target"), root.path().join("alias")).unwrap();
        symlink(root.path().join("file"), root.path().join("file-link")).unwrap();
        symlink(root.path().join("missing"), root.path().join("dangling")).unwrap();
        let listing = list_with_home(ProjectDirectoryListParams::default(), root.path()).unwrap();
        assert_eq!(
            listing
                .entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            ["alias", "target"]
        );
        assert_ne!(listing.entries[0].path, listing.entries[1].path);
        assert_eq!(
            Path::new(&listing.entries[0].path).file_name().unwrap(),
            "alias"
        );
        assert_eq!(
            resolve(&listing.entries[0].path).unwrap(),
            resolve(&listing.entries[1].path).unwrap()
        );
    }

    #[test]
    fn public_error_mapping_is_bounded() {
        assert_eq!(
            io_error(io::Error::from(io::ErrorKind::PermissionDenied)),
            ProjectDirectoryError::PermissionDenied
        );
        assert_eq!(
            io_error(io::Error::from(io::ErrorKind::Other)),
            ProjectDirectoryError::DirectoryReadFailed
        );
        assert_eq!(
            io_error(io::Error::from(io::ErrorKind::InvalidInput)),
            ProjectDirectoryError::InvalidPath
        );
    }

    #[cfg(unix)]
    #[test]
    fn inaccessible_directory_reports_permission_denied_without_elevation() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let denied = root.path().join("denied");
        std::fs::create_dir(&denied).unwrap();
        std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o000)).unwrap();
        let account_can_read = std::fs::read_dir(&denied).is_ok();
        let result = list_with_home(
            ProjectDirectoryListParams {
                path: Some(denied.to_str().unwrap().into()),
                show_hidden: false,
            },
            root.path(),
        );
        std::fs::set_permissions(&denied, std::fs::Permissions::from_mode(0o700)).unwrap();
        // A privileged test runner can read mode-000 directories. Do not claim
        // that fixture exercises denial there; the pure mapping test still runs.
        if account_can_read {
            eprintln!("permission-denied fixture bypassed by privileged test account");
            return;
        }
        assert_eq!(result.unwrap_err(), ProjectDirectoryError::PermissionDenied);
    }
}
