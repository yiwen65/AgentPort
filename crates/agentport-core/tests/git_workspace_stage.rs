mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitContextLocator, GitPathSelection, GitWorkspaceManager};
use agentport_core::CoreError;
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
fn selected_files_stage_and_unstage_without_changing_worktree_contents() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "working\n");
    fixture.write("new.txt", "new\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let before = manager.changes(&locator, true).unwrap();
    let selected = vec![
        selection(&before, "tracked.txt"),
        selection(&before, "new.txt"),
    ];

    fixture.record_write_target("stage selected files", fixture.root());
    let staged = manager
        .stage_paths(
            &locator,
            &before.context.checkout_id,
            &before.status_token,
            &selected,
        )
        .unwrap();
    assert_eq!(staged.changes.counts.staged, 2);
    assert_eq!(
        fixture
            .git(fixture.root(), &["diff", "--cached", "--name-only"])
            .lines()
            .collect::<Vec<_>>(),
        vec!["new.txt", "tracked.txt"]
    );

    let staged_new = selection(&staged.changes, "new.txt");
    fixture.record_write_target("unstage selected file", fixture.root());
    let unstaged = manager
        .unstage_paths(
            &locator,
            &staged.changes.context.checkout_id,
            &staged.changes.status_token,
            &[staged_new],
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root().join("new.txt")).unwrap(),
        "new\n"
    );
    assert!(unstaged
        .changes
        .entries
        .iter()
        .any(|entry| entry.untracked && entry.display_path == "new.txt"));
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn stale_status_token_and_ignored_selection_write_nothing() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write(".gitignore", "ignored/\n");
    fixture.git(fixture.root(), &["add", "--", ".gitignore"]);
    fixture.git(
        fixture.root(),
        &["-c", "commit.gpgsign=false", "commit", "-m", "ignore rule"],
    );
    fixture.write("tracked.txt", "first edit\n");
    fixture.write("ignored/secret.txt", "secret\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let first = manager.changes(&locator, true).unwrap();
    fixture.write("tracked.txt", "second edit\n");

    fixture.record_write_target("reject stale stage", fixture.root());
    let stale = manager
        .stage_paths(
            &locator,
            &first.context.checkout_id,
            &first.status_token,
            &[selection(&first, "tracked.txt")],
        )
        .unwrap_err();
    assert!(matches!(stale, CoreError::Conflict(_)), "{stale}");
    assert!(fixture
        .git(fixture.root(), &["diff", "--cached", "--name-only"])
        .trim()
        .is_empty());

    let refreshed = manager.changes(&locator, true).unwrap();
    let ignored = refreshed
        .entries
        .iter()
        .find(|entry| entry.ignored)
        .unwrap();
    let error = manager
        .stage_paths(
            &locator,
            &refreshed.context.checkout_id,
            &refreshed.status_token,
            &[GitPathSelection {
                path_token: ignored.path_token.clone(),
                entry_token: ignored.entry_token.clone(),
            }],
        )
        .unwrap_err();
    assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn staging_one_worktree_does_not_change_main_or_sibling_indexes() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let wt_a = fixture.add_worktree(&db, "project-a", "wt-a", "feature/a");
    let wt_b = fixture.add_worktree(&db, "project-a", "wt-b", "feature/b");
    std::fs::write(wt_a.join("tracked.txt"), "A\n").unwrap();
    std::fs::write(wt_b.join("tracked.txt"), "B\n").unwrap();
    let locator = GitContextLocator::Worktree {
        project_id: "project-a".into(),
        worktree_id: "wt-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    fixture.write("tracked.txt", "main token source\n");
    let main_changes = manager
        .changes(
            &GitContextLocator::ProjectMain {
                project_id: "project-a".into(),
            },
            true,
        )
        .unwrap();
    let cross_checkout = manager
        .stage_paths(
            &locator,
            &changes.context.checkout_id,
            &changes.status_token,
            &[selection(&main_changes, "tracked.txt")],
        )
        .unwrap_err();
    assert!(matches!(cross_checkout, CoreError::Conflict(_)));

    fixture.record_write_target("stage wt-a", &wt_a);
    manager
        .stage_paths(
            &locator,
            &changes.context.checkout_id,
            &changes.status_token,
            &[selection(&changes, "tracked.txt")],
        )
        .unwrap();

    assert_eq!(
        fixture
            .git(&wt_a, &["diff", "--cached", "--name-only"])
            .trim(),
        "tracked.txt"
    );
    assert!(fixture
        .git(fixture.root(), &["diff", "--cached", "--name-only"])
        .trim()
        .is_empty());
    assert!(fixture
        .git(&wt_b, &["diff", "--cached", "--name-only"])
        .trim()
        .is_empty());
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn conflict_resolution_stage_is_explicit_and_index_lock_failure_preserves_state() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.git(fixture.root(), &["branch", "resolve-side"]);
    let side = fixture.workspace().join("resolve-side-checkout");
    fixture.git(
        fixture.root(),
        &["worktree", "add", side.to_str().unwrap(), "resolve-side"],
    );
    fixture.write("tracked.txt", "main\n");
    fixture.git(fixture.root(), &["add", "--", "tracked.txt"]);
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "main resolution",
        ],
    );
    std::fs::write(side.join("tracked.txt"), "side\n").unwrap();
    fixture.git(&side, &["add", "--", "tracked.txt"]);
    fixture.git(
        &side,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "side resolution",
        ],
    );
    assert!(!fixture
        .git_output(fixture.root(), &["merge", "resolve-side"])
        .status
        .success());
    fixture.write("tracked.txt", "explicit resolution\n");

    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let conflict = manager.changes(&locator, true).unwrap();
    assert_eq!(conflict.counts.conflict, 1);
    fixture.record_write_target("mark conflict resolved and stage", fixture.root());
    let resolved = manager
        .stage_paths(
            &locator,
            &conflict.context.checkout_id,
            &conflict.status_token,
            &[selection(&conflict, "tracked.txt")],
        )
        .unwrap();
    assert_eq!(resolved.changes.counts.conflict, 0);
    assert!(resolved
        .changes
        .entries
        .iter()
        .any(|entry| entry.display_path == "tracked.txt" && entry.staged));

    fixture.write("after-lock.txt", "must remain untracked\n");
    let before_lock = manager.changes(&locator, true).unwrap();
    let index_lock = fixture.root().join(".git/index.lock");
    std::fs::write(&index_lock, "external lock\n").unwrap();
    fixture.record_write_target("stage blocked by external index lock", fixture.root());
    let error = manager
        .stage_paths(
            &locator,
            &before_lock.context.checkout_id,
            &before_lock.status_token,
            &[selection(&before_lock, "after-lock.txt")],
        )
        .unwrap_err();
    assert!(matches!(error, CoreError::Git(_)), "{error}");
    std::fs::remove_file(index_lock).unwrap();
    assert!(fixture
        .git(fixture.root(), &["diff", "--cached", "--name-only"])
        .lines()
        .all(|path| path != "after-lock.txt"));
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn submodule_status_and_staging_operate_only_on_the_gitlink() {
    let fixture = MockRepo::new();
    let submodule_source = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            submodule_source.root().to_str().unwrap(),
            "module",
        ],
    );
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-am",
            "add mock submodule",
        ],
    );
    let module = fixture.root().join("module");
    fixture.git(&module, &["config", "user.name", "Submodule Test"]);
    fixture.git(&module, &["config", "user.email", "submodule@test.invalid"]);
    std::fs::write(module.join("tracked.txt"), "new submodule commit\n").unwrap();
    fixture.git(&module, &["add", "--", "tracked.txt"]);
    fixture.git(
        &module,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "advance submodule",
        ],
    );
    std::fs::write(module.join("inner-untracked.txt"), "do not recurse\n").unwrap();

    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    let module_entry = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "module")
        .unwrap();
    assert!(module_entry.submodule_state.is_some());
    fixture.record_write_target("stage submodule gitlink", fixture.root());
    let staged = manager
        .stage_paths(
            &locator,
            &changes.context.checkout_id,
            &changes.status_token,
            &[selection(&changes, "module")],
        )
        .unwrap();
    assert!(staged
        .changes
        .entries
        .iter()
        .any(|entry| entry.display_path == "module" && entry.staged));
    assert!(fixture
        .git(
            &module,
            &["status", "--porcelain", "--", "inner-untracked.txt"]
        )
        .starts_with("??"));
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "record advanced gitlink",
        ],
    );
    let nested_only = manager.changes(&locator, true).unwrap();
    let nested_entry = nested_only
        .entries
        .iter()
        .find(|entry| entry.display_path == "module")
        .unwrap();
    assert!(nested_entry
        .submodule_state
        .as_deref()
        .is_some_and(|state| state.as_bytes().get(1) == Some(&b'.')));
    fixture.record_write_target("reject recursive submodule stage", fixture.root());
    let error = manager
        .stage_paths(
            &locator,
            &nested_only.context.checkout_id,
            &nested_only.status_token,
            &[selection(&nested_only, "module")],
        )
        .unwrap_err();
    assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn repository_file_lock_times_out_without_entering_git_mutation() {
    use agentport_core::git::RepositoryFileLock;
    use std::time::Duration;

    let fixture = MockRepo::new();
    fixture.record_write_target("repository file lock", fixture.root());
    let common_dir = fixture.root().join(".git");
    let _held =
        RepositoryFileLock::acquire_with_timeout(&common_dir, Duration::from_millis(50)).unwrap();
    let error = RepositoryFileLock::acquire_with_timeout(&common_dir, Duration::from_millis(50))
        .err()
        .expect("second lock must time out");
    assert!(matches!(error, CoreError::Timeout(_)), "{error}");
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn unborn_unstage_removes_only_index_entry_and_preserves_worktree_file() {
    let fixture = MockRepo::new_unborn();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-unborn");
    fixture.write("first.txt", "keep this worktree content\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-unborn".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    assert!(changes.context.unborn);
    fixture.record_write_target("stage unborn file", fixture.root());
    let staged = manager
        .stage_paths(
            &locator,
            &changes.context.checkout_id,
            &changes.status_token,
            &[selection(&changes, "first.txt")],
        )
        .unwrap()
        .changes;
    fixture.record_write_target("unstage unborn file", fixture.root());
    let unstaged = manager
        .unstage_paths(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            &[selection(&staged, "first.txt")],
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root().join("first.txt")).unwrap(),
        "keep this worktree content\n"
    );
    assert!(unstaged
        .changes
        .entries
        .iter()
        .any(|entry| entry.display_path == "first.txt" && entry.untracked));
    assert!(fixture
        .git(fixture.root(), &["ls-files", "--stage"])
        .trim()
        .is_empty());
    fixture.assert_recorded_write_targets_are_isolated();
}
