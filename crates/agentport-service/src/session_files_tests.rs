use super::*;
use std::os::unix::fs::{symlink, PermissionsExt};

fn run(root: &Path, path: Option<&str>, list: bool) -> Result<serde_json::Value> {
    execute(root.to_str().unwrap(), path, list)
}

#[test]
fn session_files_lists_and_reads_relative_paths_and_internal_aliases() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("Zoo")).unwrap();
    std::fs::create_dir(root.path().join("alpha")).unwrap();
    std::fs::create_dir(root.path().join(".git")).unwrap();
    std::fs::write(root.path().join("b.md"), "# hello\n中文").unwrap();
    std::fs::write(root.path().join("A.txt"), "A").unwrap();
    std::fs::write(root.path().join("alpha/note"), "nested").unwrap();
    symlink(root.path().join("alpha"), root.path().join("alias")).unwrap();
    let list = run(root.path(), None, true).unwrap();
    assert_eq!(
        list["rootPath"],
        std::fs::canonicalize(root.path())
            .unwrap()
            .to_str()
            .unwrap()
    );
    assert_eq!(list["path"], ".");
    assert_eq!(list["truncated"], false);
    let names = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(names, ["alias", "alpha", "Zoo", "A.txt", "b.md"]);
    assert_eq!(list["entries"][0]["isDir"], true);
    assert_eq!(list["entries"][0]["path"], "alias");
    let nested = run(root.path(), Some("./alias/./"), true).unwrap();
    assert_eq!(nested["path"], "alias");
    assert_eq!(nested["entries"][0]["path"], "alias/note");
    assert_eq!(
        run(root.path(), Some("alias/note"), false).unwrap()["content"],
        "nested"
    );
    let read = run(root.path(), Some("b.md"), false).unwrap();
    assert_eq!(read["content"], "# hello\n中文");
    assert_eq!(read["sizeBytes"], "# hello\n中文".len());
    assert_eq!(read["truncated"], false);
}

#[test]
fn session_files_rejects_traversal_absolute_external_links_and_prefix_siblings() {
    let parent = tempfile::tempdir().unwrap();
    let root = parent.path().join("project");
    let sibling = parent.path().join("project-secret");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("secret"), "PRIVATE").unwrap();
    symlink(&sibling, root.join("escape")).unwrap();
    symlink(sibling.join("secret"), root.join("file-escape")).unwrap();
    symlink(root.join("missing"), root.join("dangling")).unwrap();
    for path in [
        "..",
        "../project-secret/secret",
        "inside/../note",
        "escape/secret",
        "file-escape",
    ] {
        assert_eq!(
            run(&root, Some(path), false).unwrap_err(),
            SessionFilesError::OutsideRoot,
            "{path}"
        );
    }
    for path in ["", "/etc/passwd", "C:\\secret", "a\\b", "bad\0name"] {
        assert_eq!(
            run(&root, Some(path), false).unwrap_err(),
            SessionFilesError::InvalidPath,
            "{path}"
        );
    }
    assert_eq!(
        run(&root, None, false).unwrap_err(),
        SessionFilesError::InvalidPath
    );
    assert_eq!(
        run(&root, Some("dangling"), false).unwrap_err(),
        SessionFilesError::PathNotFound
    );
    let list = run(&root, None, true).unwrap();
    assert_eq!(list["entries"], serde_json::json!([]));
}

#[test]
fn session_files_rejects_special_binary_missing_and_wrong_kind_paths() {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("dir")).unwrap();
    std::fs::write(root.path().join("binary"), b"a\0b").unwrap();
    std::fs::write(root.path().join("invalid-utf8"), [0xff]).unwrap();
    std::fs::write(root.path().join("control"), [1, 2, 3]).unwrap();
    assert!(std::process::Command::new("mkfifo")
        .arg(root.path().join("fifo"))
        .status()
        .unwrap()
        .success());
    let _socket = std::os::unix::net::UnixListener::bind(root.path().join("socket")).unwrap();
    for path in [
        ".",
        "dir",
        "binary",
        "invalid-utf8",
        "control",
        "fifo",
        "socket",
    ] {
        assert_eq!(
            run(root.path(), Some(path), false).unwrap_err(),
            SessionFilesError::UnsupportedFile,
            "{path}"
        );
    }
    assert_eq!(
        run(root.path(), Some("binary"), true).unwrap_err(),
        SessionFilesError::NotDirectory
    );
    assert_eq!(
        run(root.path(), Some("missing"), false).unwrap_err(),
        SessionFilesError::PathNotFound
    );
    let entries = run(root.path(), None, true).unwrap()["entries"]
        .as_array()
        .unwrap()
        .clone();
    assert!(!entries
        .iter()
        .any(|entry| entry["name"] == "fifo" || entry["name"] == "socket"));
}

#[test]
fn session_files_limits_directory_entries_and_utf8_content() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..MAX_ENTRIES + 1 {
        std::fs::write(root.path().join(format!("file-{index:04}")), "").unwrap();
    }
    let list = run(root.path(), None, true).unwrap();
    assert_eq!(list["entries"].as_array().unwrap().len(), MAX_ENTRIES);
    assert_eq!(list["truncated"], true);
    let mut text = "x".repeat(MAX_BYTES - 1);
    text.push_str("中文");
    std::fs::write(root.path().join("large"), &text).unwrap();
    let read = run(root.path(), Some("large"), false).unwrap();
    assert_eq!(read["content"].as_str().unwrap().len(), MAX_BYTES - 1);
    assert_eq!(read["sizeBytes"], text.len());
    assert_eq!(read["truncated"], true);
    std::fs::write(root.path().join("exact"), "x".repeat(MAX_BYTES)).unwrap();
    assert_eq!(
        run(root.path(), Some("exact"), false).unwrap()["truncated"],
        false
    );
}

#[test]
fn session_files_reports_permission_denied_without_host_details() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("private");
    std::fs::write(&path, "secret").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
    // A root test runner can bypass mode bits; the explicit mapper assertion
    // still checks the wire error, while normal service users exercise the IO.
    if std::fs::File::open(&path).is_err() {
        assert_eq!(
            run(root.path(), Some("private"), false).unwrap_err(),
            SessionFilesError::PermissionDenied
        );
    }
    assert_eq!(
        io_error(io::Error::from(io::ErrorKind::PermissionDenied)),
        SessionFilesError::PermissionDenied
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

#[test]
fn session_files_facade_uses_only_server_session_cwd_and_isolates_sessions() {
    use crate::*;
    use chrono::Utc;
    let service = CoreService::memory().unwrap();
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    for (id, root, content) in [("one", first.path(), "ONE"), ("two", second.path(), "TWO")] {
        std::fs::write(root.join("note"), content).unwrap();
        let project = service
            .add_project(ProjectAddParams {
                path: root.to_str().unwrap().into(),
                name: None,
            })
            .unwrap();
        service
            .db
            .insert_session(&Session {
                id: id.into(),
                project_id: project.project.id,
                worktree_id: None,
                preset_id: "pre_shell_safe".into(),
                title: id.into(),
                cwd: root.to_str().unwrap().into(),
                host_pid: None,
                host_socket: None,
                host_token: "fixture-secret".into(),
                lifecycle: Lifecycle::Exited,
                agent_session_id: None,
                resume_precision: ResumePrecision::Unavailable,
                adapter_type: AgentType::Shell,
                transport: AgentTransport::Pty,
                command: Vec::new(),
                permission_mode: PermissionMode::Native,
                pinned_at: None,
                created_at: Utc::now(),
                updated_at: Utc::now(),
                archived_at: None,
            })
            .unwrap();
        let read = service
            .extended_facade(
                "session.files.read",
                serde_json::json!({"sessionId": id, "path": "note"}),
            )
            .unwrap();
        assert_eq!(read["content"], content);
        assert_eq!(
            read["rootPath"],
            std::fs::canonicalize(root).unwrap().to_str().unwrap()
        );
        assert_eq!(
            service
                .extended_facade("session.files.list", serde_json::json!({"sessionId": id}))
                .unwrap()["path"],
            "."
        );
        let open = service.extended_facade("session.files.download.open",
            serde_json::json!({"sessionId":id,"path":"note"})).unwrap();
        let download_id = open["downloadId"].as_str().unwrap();
        let other = CoreService::memory().unwrap();
        assert!(matches!(other.extended_facade("session.files.download.chunk",
            serde_json::json!({"downloadId":download_id,"offset":0})),
            Err(ServiceError::SessionFiles(SessionFilesError::InvalidDownload))));
        let chunk = service.extended_facade("session.files.download.chunk",
            serde_json::json!({"downloadId":download_id,"offset":0})).unwrap();
        use base64::Engine as _;
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(
            chunk["contentBase64"].as_str().unwrap()).unwrap(), content.as_bytes());
        assert_eq!(service.extended_facade("session.files.download.finish",
            serde_json::json!({"downloadId":download_id})).unwrap()["sizeBytes"], content.len());
        assert_eq!(service.extended_facade("session.files.download.close",
            serde_json::json!({"downloadId":download_id})).unwrap()["closed"], true);
    }
    let errors = [
        (
            serde_json::json!({"sessionId":"missing", "path":"note"}),
            SessionFilesError::SessionNotFound,
        ),
        (
            serde_json::json!({"sessionId":"one", "path":"note", "rootPath":second.path()}),
            SessionFilesError::InvalidPath,
        ),
        (
            serde_json::json!({"sessionId":"one"}),
            SessionFilesError::InvalidPath,
        ),
        (
            serde_json::json!({"sessionId":"one", "path":"../note"}),
            SessionFilesError::OutsideRoot,
        ),
        (
            serde_json::json!({"sessionId":"one", "path":second.path().join("note")}),
            SessionFilesError::InvalidPath,
        ),
    ];
    for (params, expected) in errors {
        assert!(
            matches!(service.extended_facade("session.files.read", params), Err(ServiceError::SessionFiles(error)) if error == expected)
        );
    }
    for (params, expected) in [
        (serde_json::json!({"sessionId":"missing","path":"note"}), SessionFilesError::SessionNotFound),
        (serde_json::json!({"sessionId":"one","path":"note","rootPath":second.path()}), SessionFilesError::InvalidPath),
        (serde_json::json!({"sessionId":"one"}), SessionFilesError::InvalidPath),
        (serde_json::json!({"sessionId":"one","path":"../note"}), SessionFilesError::OutsideRoot),
    ] {
        assert!(matches!(service.extended_facade("session.files.download.open", params),
            Err(ServiceError::SessionFiles(error)) if error == expected));
    }
    // Existing unscoped document callers remain unchanged.
    assert_eq!(
        service
            .extended_facade(
                "document.read",
                serde_json::json!({"path":second.path().join("note")})
            )
            .unwrap()["content"],
        "TWO"
    );
}
