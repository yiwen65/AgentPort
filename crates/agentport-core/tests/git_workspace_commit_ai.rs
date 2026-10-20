mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitContextLocator, GitWorkspaceManager};
use agentport_core::models::Project;
use agentport_core::CoreError;
use chrono::Utc;
use support::mock_repo::MockRepo;

#[test]
fn commit_ai_context_contains_only_the_staged_snapshot() {
    let fixture = MockRepo::new();
    fixture.write("tracked.txt", "staged version\n");
    fixture.git(fixture.root(), &["add", "--", "tracked.txt"]);
    fixture.write("tracked.txt", "unstaged version\n");

    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let snapshot = manager.changes(&locator, true).unwrap();

    let context = manager
        .commit_ai_context(
            &locator,
            &snapshot.context.checkout_id,
            &snapshot.status_token,
        )
        .unwrap();

    assert!(context.staged_diff.contains("+staged version"));
    assert!(!context.staged_diff.contains("unstaged version"));
    assert_eq!(context.status_token, snapshot.status_token);
}

#[test]
fn commit_ai_context_rejects_stale_status_and_an_empty_index() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let clean = manager.changes(&locator, true).unwrap();

    let stale = manager
        .commit_ai_context(&locator, &clean.context.checkout_id, "stale-token")
        .unwrap_err();
    assert!(matches!(stale, CoreError::Conflict(_)), "{stale}");

    let empty = manager
        .commit_ai_context(&locator, &clean.context.checkout_id, &clean.status_token)
        .unwrap_err();
    assert!(matches!(empty, CoreError::Blocked(_)), "{empty}");
}

#[test]
fn commit_ai_context_never_sends_staged_content_outside_the_project_directory() {
    let fixture = MockRepo::new();
    std::fs::create_dir_all(fixture.root().join("app")).unwrap();
    fixture.write("app/inside.txt", "inside\n");
    fixture.write("outside.txt", "sibling project secret\n");
    fixture.git(
        fixture.root(),
        &["add", "--", "app/inside.txt", "outside.txt"],
    );

    let db = Db::open_memory().unwrap();
    let project_root = fixture.root().join("app");
    db.add_project(&Project {
        id: "project-a".into(),
        name: "project-a".into(),
        root_path: project_root.to_string_lossy().into_owned(),
        git_root_path: Some(fixture.root().to_string_lossy().into_owned()),
        created_at: Utc::now(),
        pinned: false,
        sort_order: 0,
    })
    .unwrap();
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let snapshot = manager.changes(&locator, true).unwrap();

    let context = manager
        .commit_ai_context(
            &locator,
            &snapshot.context.checkout_id,
            &snapshot.status_token,
        )
        .unwrap();

    assert!(
        context.staged_diff.contains("+inside"),
        "the project's own staged file is described: {}",
        context.staged_diff
    );
    assert!(
        !context.staged_diff.contains("sibling project secret"),
        "staged content outside the project boundary must never be sent to the model: {}",
        context.staged_diff
    );
}

#[cfg(unix)]
#[test]
fn commit_ai_context_does_not_execute_repository_textconv_converters() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = MockRepo::new();
    let marker = fixture.workspace().join("textconv-ran");
    let converter = fixture.workspace().join("textconv.sh");
    std::fs::write(
        &converter,
        format!(
            "#!/bin/sh\ntouch '{}'\ncat \"$1\"\n",
            marker.to_string_lossy()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&converter, std::fs::Permissions::from_mode(0o755)).unwrap();
    fixture.git(
        fixture.root(),
        &[
            "config",
            "diff.marker.textconv",
            converter.to_str().unwrap(),
        ],
    );
    fixture.write(".gitattributes", "*.secret diff=marker\n");
    fixture.write("data.secret", "converted content\n");
    fixture.git(
        fixture.root(),
        &["add", "--", ".gitattributes", "data.secret"],
    );

    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let snapshot = manager.changes(&locator, true).unwrap();
    manager
        .commit_ai_context(
            &locator,
            &snapshot.context.checkout_id,
            &snapshot.status_token,
        )
        .unwrap();

    assert!(
        !marker.exists(),
        "generating a commit message must not run repository-configured textconv programs"
    );
}
