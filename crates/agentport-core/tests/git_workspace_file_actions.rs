mod support;

use agentport_core::db::Db;
use agentport_core::git::{
    GitContextLocator, GitIgnoreTarget, GitPathSelection, GitWorkspaceManager,
};
use support::mock_repo::MockRepo;

fn selection(snapshot: &agentport_core::git::GitChangesSnapshot, path: &str) -> GitPathSelection {
    let entry = snapshot
        .entries
        .iter()
        .find(|entry| entry.display_path == path)
        .unwrap();
    GitPathSelection {
        path_token: entry.path_token.clone(),
        entry_token: entry.entry_token.clone(),
    }
}

#[test]
fn discard_and_ignore_actions_are_checkout_and_status_bound() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "working\n");
    fixture.write("scratch.txt", "local\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let before = manager.changes(&locator, true).unwrap();

    fixture.record_write_target("discard tracked file", fixture.root());
    let discarded = manager
        .discard_paths(
            &locator,
            &before.context.checkout_id,
            &before.status_token,
            &[selection(&before, "tracked.txt")],
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root().join("tracked.txt")).unwrap(),
        "base\n"
    );

    fixture.record_write_target("add repository ignore", fixture.root());
    let ignored = manager
        .ignore_path(
            &locator,
            &discarded.changes.context.checkout_id,
            &discarded.changes.status_token,
            &selection(&discarded.changes, "scratch.txt"),
            GitIgnoreTarget::Repository,
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root().join(".gitignore")).unwrap(),
        "/scratch.txt\n"
    );
    assert!(ignored
        .changes
        .entries
        .iter()
        .any(|entry| entry.ignored && entry.display_path == "scratch.txt"));
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn view_and_trash_accept_only_the_current_untracked_entry() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("scratch.txt", "local\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let before = manager.changes(&locator, true).unwrap();
    let scratch = selection(&before, "scratch.txt");

    let resolved = manager
        .resolve_file(
            &locator,
            &before.context.checkout_id,
            &before.status_token,
            &scratch,
        )
        .unwrap();
    assert_eq!(resolved.display_path, "scratch.txt");
    assert_eq!(
        std::fs::canonicalize(&resolved.absolute_path).unwrap(),
        std::fs::canonicalize(fixture.root().join("scratch.txt")).unwrap()
    );

    fixture.record_write_target("trash untracked file", fixture.root());
    let trashed = manager
        .trash_path(
            &locator,
            &before.context.checkout_id,
            &before.status_token,
            &scratch,
            |path| {
                std::fs::remove_file(path)?;
                Ok(())
            },
        )
        .unwrap();
    assert!(!fixture.root().join("scratch.txt").exists());
    assert_eq!(trashed.changes.counts.untracked, 0);
    fixture.assert_recorded_write_targets_are_isolated();
}
