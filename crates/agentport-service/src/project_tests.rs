use super::*;

#[test]
fn directory_reads_do_not_register_projects_or_create_files() {
    let service = CoreService::memory().unwrap();
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("ordinary")).unwrap();
    let before = std::fs::read_dir(root.path()).unwrap().count();
    let listing = service
        .list_project_directories(ProjectDirectoryListParams {
            path: Some(root.path().to_str().unwrap().into()),
            show_hidden: false,
        })
        .unwrap();
    let resolved = service
        .resolve_project_directory(ProjectDirectoryResolveParams {
            path: root.path().to_str().unwrap().into(),
        })
        .unwrap();
    assert_eq!(listing.path, resolved.path);
    assert_eq!(listing.entries[0].name, "ordinary");
    assert!(service.list_projects().unwrap().is_empty());
    assert!(service.list_sessions(false).unwrap().is_empty());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), before);
    assert!(!service.paths.root().exists());
    #[allow(deprecated)]
    let home = std::env::home_dir().unwrap();
    assert_eq!(
        listing.home_path,
        project_directory::resolve(home.to_str().unwrap()).unwrap()
    );
    let capabilities = service.service_snapshot().capabilities;
    for name in ["project.directory.read", "project.write"] {
        assert!(capabilities
            .iter()
            .any(|capability| capability.name == name && capability.enabled));
    }
}

#[test]
fn add_supports_non_git_directories_trims_names_and_does_not_rename_duplicates() {
    let service = CoreService::memory().unwrap();
    let root = tempfile::tempdir().unwrap();
    let first = service
        .add_project(ProjectAddParams {
            path: root.path().to_str().unwrap().into(),
            name: Some("  My project  ".into()),
        })
        .unwrap();
    assert_eq!(first.project.name, "My project");
    assert_eq!(first.project.git_root_path, None);
    assert!(!first.focused_existing);
    let again = service
        .add_project(ProjectAddParams {
            path: root.path().join(".").to_str().unwrap().into(),
            name: Some("DO NOT RENAME".into()),
        })
        .unwrap();
    assert!(again.focused_existing);
    assert_eq!(again.project, first.project);
    #[cfg(unix)]
    {
        let aliases = tempfile::tempdir().unwrap();
        let alias = aliases.path().join("alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        let through_alias = service
            .add_project(ProjectAddParams {
                path: alias.to_str().unwrap().into(),
                name: None,
            })
            .unwrap();
        assert!(through_alias.focused_existing);
        assert_eq!(through_alias.project, first.project);
    }
    assert_eq!(service.list_projects().unwrap(), vec![first.project]);
    assert!(service.list_sessions(false).unwrap().is_empty());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn add_defaults_empty_name_to_basename_and_validates_unicode_character_bound() {
    let service = CoreService::memory().unwrap();
    let root = tempfile::tempdir().unwrap();
    for (directory, name) in [("missing-name", None), ("empty-name", Some("  \n ".into()))] {
        let path = root.path().join(directory);
        std::fs::create_dir(&path).unwrap();
        let result = service
            .add_project(ProjectAddParams {
                path: path.to_str().unwrap().into(),
                name,
            })
            .unwrap();
        assert_eq!(result.project.name, directory);
    }
    let path = root.path().join("long-name");
    std::fs::create_dir(&path).unwrap();
    let params = ProjectAddParams {
        path: path.to_str().unwrap().into(),
        name: Some("界".repeat(81)),
    };
    assert!(matches!(
        service.add_project(params),
        Err(ServiceError::InvalidRequest)
    ));
    assert_eq!(service.list_projects().unwrap().len(), 2);
    let result = service
        .add_project(ProjectAddParams {
            path: path.to_str().unwrap().into(),
            name: Some("界".repeat(80)),
        })
        .unwrap();
    assert_eq!(result.project.name.chars().count(), 80);
}

#[test]
fn overlong_directory_basename_requires_a_short_explicit_name_before_writing() {
    let service = CoreService::memory().unwrap();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("p".repeat(81));
    std::fs::create_dir(&path).unwrap();
    assert!(matches!(
        service.add_project(ProjectAddParams {
            path: path.to_str().unwrap().into(),
            name: None,
        }),
        Err(ServiceError::InvalidRequest)
    ));
    assert!(service.list_projects().unwrap().is_empty());
    let result = service
        .add_project(ProjectAddParams {
            path: path.to_str().unwrap().into(),
            name: Some("Short name".into()),
        })
        .unwrap();
    assert_eq!(result.project.name, "Short name");
}

#[test]
fn add_path_preflight_retains_typed_errors_and_does_not_create_missing_directories() {
    let service = CoreService::memory().unwrap();
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("file");
    std::fs::write(&file, "untouched").unwrap();
    let missing = root.path().join("missing");
    for (path, expected) in [
        ("relative".to_owned(), ProjectDirectoryError::InvalidPath),
        (
            missing.to_str().unwrap().into(),
            ProjectDirectoryError::PathNotFound,
        ),
        (
            file.to_str().unwrap().into(),
            ProjectDirectoryError::NotDirectory,
        ),
    ] {
        assert!(
            matches!(service.add_project(ProjectAddParams { path, name: None }),
            Err(ServiceError::ProjectDirectory(error)) if error == expected)
        );
    }
    assert!(!missing.exists());
    assert!(service.list_projects().unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(file).unwrap(), "untouched");
}

#[cfg(unix)]
#[test]
fn add_reports_permission_denied_before_writing_when_a_parent_is_inaccessible() {
    use std::os::unix::fs::PermissionsExt;
    let service = CoreService::memory().unwrap();
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("denied");
    let child = parent.join("project");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o000)).unwrap();
    let account_can_resolve = std::fs::canonicalize(&child).is_ok();
    let result = service.add_project(ProjectAddParams {
        path: child.to_str().unwrap().into(),
        name: None,
    });
    std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700)).unwrap();
    if account_can_resolve {
        eprintln!("permission-denied add fixture bypassed by privileged test account");
        return;
    }
    assert!(matches!(
        result,
        Err(ServiceError::ProjectDirectory(
            ProjectDirectoryError::PermissionDenied
        ))
    ));
    assert!(service.list_projects().unwrap().is_empty());
    assert!(std::fs::read_dir(child).unwrap().next().is_none());
}

#[test]
fn concurrent_adds_across_shared_database_connections_focus_one_winner() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("ordinary-project");
    std::fs::create_dir(&path).unwrap();
    let paths = AppPaths::new(root.path().join("app"));
    // Distinct service connections model desktop and multiple Bridge processes
    // racing on the same existing project DB, not just one service Mutex.
    let services = (0..8)
        .map(|_| CoreService::open(paths.clone()).unwrap())
        .collect::<Vec<_>>();
    let barrier = Arc::new(std::sync::Barrier::new(services.len()));
    let handles = services
        .into_iter()
        .enumerate()
        .map(|(index, service)| {
            let barrier = barrier.clone();
            let path = path.to_str().unwrap().to_owned();
            std::thread::spawn(move || {
                barrier.wait();
                service
                    .add_project(ProjectAddParams {
                        path,
                        name: Some(format!("winner-{index}")),
                    })
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    let results = handles
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        results
            .iter()
            .filter(|result| !result.focused_existing)
            .count(),
        1
    );
    assert!(results
        .iter()
        .all(|result| result.project == results[0].project));
    let shared = CoreService::open(paths).unwrap();
    assert_eq!(
        shared.list_projects().unwrap(),
        vec![results[0].project.clone()]
    );
    assert!(shared.list_sessions(false).unwrap().is_empty());
    assert!(std::fs::read_dir(path).unwrap().next().is_none());
}
