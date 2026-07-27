mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitContextLocator, GitWorkspaceManager};
use agentport_core::CoreError;
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
