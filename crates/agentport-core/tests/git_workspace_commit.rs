mod support;

use agentport_core::db::Db;
use agentport_core::git::{
    GitCommitOutcome, GitContextLocator, GitPathSelection, GitWorkspaceManager,
};
use agentport_core::models::Project;
use agentport_core::CoreError;
use chrono::Utc;
use support::mock_repo::MockRepo;

fn stage_tracked(
    fixture: &MockRepo,
    manager: &GitWorkspaceManager<'_>,
    locator: &GitContextLocator,
) -> agentport_core::git::GitChangesSnapshot {
    let changes = manager.changes(locator, true).unwrap();
    let entry = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "tracked.txt")
        .unwrap();
    fixture.record_write_target("stage tracked file", fixture.root());
    manager
        .stage_paths(
            locator,
            &changes.context.checkout_id,
            &changes.status_token,
            &[GitPathSelection {
                path_token: entry.path_token.clone(),
                entry_token: entry.entry_token.clone(),
            }],
        )
        .unwrap()
        .changes
}

#[test]
fn commit_requires_review_and_commits_the_exact_staged_manifest() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "committed from Git Center\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let staged = stage_tracked(&fixture, &manager, &locator);
    let before_head = fixture.git(fixture.root(), &["rev-parse", "HEAD"]);
    let review = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            "feat: exact mock commit\n\nBody",
        )
        .unwrap();

    assert_eq!(review.files.len(), 1);
    assert_eq!(review.files[0].display_path, "tracked.txt");
    assert_eq!(review.message, "feat: exact mock commit\n\nBody");
    assert!(!review.commit_token.is_empty());
    assert_eq!(
        review.expected_tree_oid,
        fixture
            .git(fixture.root(), &["write-tree"])
            .trim()
            .to_owned(),
        "the in-memory index tree calculation must match Git"
    );

    fixture.record_write_target("commit exact staged manifest", fixture.root());
    let result = manager
        .commit_changes(
            &locator,
            &review.context.checkout_id,
            &review.commit_token,
            &review.message,
        )
        .unwrap();
    assert_eq!(result.outcome, GitCommitOutcome::Succeeded);
    assert_ne!(result.after_head.as_deref(), Some(before_head.trim()),);
    assert_eq!(
        fixture
            .git(fixture.root(), &["show", "-s", "--format=%s", "HEAD"])
            .trim(),
        "feat: exact mock commit"
    );
    assert_eq!(result.changes.counts.staged, 0);
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn stale_commit_token_performs_zero_commit_and_invalid_messages_are_rejected() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "first staged value\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let staged = stage_tracked(&fixture, &manager, &locator);
    let invalid = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            "   \nbody",
        )
        .unwrap_err();
    assert!(matches!(invalid, CoreError::Validation(_)), "{invalid}");

    let review = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            "valid subject",
        )
        .unwrap();
    let before = fixture.git(fixture.root(), &["rev-parse", "HEAD"]);
    fixture.write("second.txt", "external index change\n");
    fixture.git(fixture.root(), &["add", "--", "second.txt"]);

    fixture.record_write_target("reject stale commit token", fixture.root());
    let stale = manager
        .commit_changes(
            &locator,
            &review.context.checkout_id,
            &review.commit_token,
            &review.message,
        )
        .unwrap_err();
    assert!(matches!(stale, CoreError::Conflict(_)), "{stale}");
    assert_eq!(fixture.git(fixture.root(), &["rev-parse", "HEAD"]), before);
    fixture.assert_recorded_write_targets_are_isolated();
}

#[cfg(unix)]
#[test]
fn hook_scope_change_is_reported_after_commit_without_rollback() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "confirmed scope\n");
    fixture.write("hook-added.txt", "hook scope\n");
    let hook = fixture.root().join(".git/hooks/pre-commit");
    std::fs::write(&hook, "#!/bin/sh\ngit add -- hook-added.txt\n").unwrap();
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let staged = stage_tracked(&fixture, &manager, &locator);
    let review = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            "hook scope test",
        )
        .unwrap();

    fixture.record_write_target("commit with scope-changing hook", fixture.root());
    let result = manager
        .commit_changes(
            &locator,
            &review.context.checkout_id,
            &review.commit_token,
            &review.message,
        )
        .unwrap();
    assert_eq!(result.outcome, GitCommitOutcome::ScopeDrift);
    assert!(fixture
        .git(
            fixture.root(),
            &["show", "--format=", "--name-only", "HEAD"]
        )
        .lines()
        .any(|path| path == "hook-added.txt"));
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn root_commit_supports_nested_index_tree_and_unborn_head() {
    let fixture = MockRepo::new_unborn();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-root");
    fixture.write("nested/first.txt", "root commit\n");
    fixture.write("second.txt", "second\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-root".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    assert!(changes.context.unborn);
    let selections = changes
        .entries
        .iter()
        .filter(|entry| entry.untracked)
        .map(|entry| GitPathSelection {
            path_token: entry.path_token.clone(),
            entry_token: entry.entry_token.clone(),
        })
        .collect::<Vec<_>>();
    fixture.record_write_target("stage root commit files", fixture.root());
    let staged = manager
        .stage_paths(
            &locator,
            &changes.context.checkout_id,
            &changes.status_token,
            &selections,
        )
        .unwrap()
        .changes;
    let long_subject = "r".repeat(73);
    let review = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            &long_subject,
        )
        .unwrap();
    assert!(review.subject_over_72);
    assert!(review.before_head.is_none());
    assert_eq!(
        review.expected_tree_oid,
        fixture.git(fixture.root(), &["write-tree"]).trim()
    );
    fixture.record_write_target("create root commit", fixture.root());
    let result = manager
        .commit_changes(
            &locator,
            &review.context.checkout_id,
            &review.commit_token,
            &review.message,
        )
        .unwrap();
    assert_eq!(result.outcome, GitCommitOutcome::Succeeded);
    assert!(result.before_head.is_none());
    assert!(fixture
        .git(fixture.root(), &["show", "-s", "--format=%P", "HEAD"])
        .trim()
        .is_empty());
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn commit_validation_blocks_empty_scope_detached_head_and_oversized_messages() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let clean = manager.changes(&locator, true).unwrap();
    let empty = manager
        .prepare_commit(
            &locator,
            &clean.context.checkout_id,
            &clean.status_token,
            "valid subject",
        )
        .unwrap_err();
    assert!(matches!(empty, CoreError::Blocked(_)), "{empty}");
    let nul = manager
        .prepare_commit(
            &locator,
            &clean.context.checkout_id,
            &clean.status_token,
            "bad\0message",
        )
        .unwrap_err();
    assert!(matches!(nul, CoreError::Validation(_)), "{nul}");
    let oversized = format!("subject\n{}", "x".repeat(64 * 1024));
    let oversized = manager
        .prepare_commit(
            &locator,
            &clean.context.checkout_id,
            &clean.status_token,
            &oversized,
        )
        .unwrap_err();
    assert!(matches!(oversized, CoreError::Validation(_)), "{oversized}");

    fixture.git(fixture.root(), &["checkout", "--detach"]);
    let detached = manager.changes(&locator, true).unwrap();
    let error = manager
        .prepare_commit(
            &locator,
            &detached.context.checkout_id,
            &detached.status_token,
            "detached commit",
        )
        .unwrap_err();
    assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    assert!(error.to_string().contains("detached"));
}

#[test]
fn head_drift_after_review_is_zero_write_and_preserves_the_draft_scope() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "staged before head drift\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let staged = stage_tracked(&fixture, &manager, &locator);
    let review = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            "draft survives head drift",
        )
        .unwrap();
    let before = review.before_head.clone().unwrap();
    let tree = fixture
        .git(fixture.root(), &["rev-parse", "HEAD^{tree}"])
        .trim()
        .to_owned();
    let external = fixture
        .git(
            fixture.root(),
            &["commit-tree", &tree, "-p", &before, "-m", "external head"],
        )
        .trim()
        .to_owned();
    fixture.git(
        fixture.root(),
        &["update-ref", "refs/heads/main", &external, &before],
    );

    fixture.record_write_target("reject head drift commit", fixture.root());
    let error = manager
        .commit_changes(
            &locator,
            &review.context.checkout_id,
            &review.commit_token,
            &review.message,
        )
        .unwrap_err();
    assert!(matches!(error, CoreError::Conflict(_)), "{error}");
    assert_eq!(
        fixture.git(fixture.root(), &["rev-parse", "HEAD"]).trim(),
        external
    );
    assert!(fixture
        .git(fixture.root(), &["diff", "--cached", "--name-only"])
        .lines()
        .any(|path| path == "tracked.txt"));
    fixture.assert_recorded_write_targets_are_isolated();
}

#[cfg(unix)]
#[test]
fn missing_identity_and_rejecting_hook_report_not_executed_and_keep_index() {
    use std::os::unix::fs::PermissionsExt;

    for failure in ["identity", "hook"] {
        let fixture = MockRepo::new();
        let db = Db::open_memory().unwrap();
        fixture.add_project(&db, "project-a");
        fixture.write("tracked.txt", format!("{failure} failure\n"));
        let locator = GitContextLocator::ProjectMain {
            project_id: "project-a".into(),
        };
        let manager = GitWorkspaceManager::new(&db);
        let staged = stage_tracked(&fixture, &manager, &locator);
        let review = manager
            .prepare_commit(
                &locator,
                &staged.context.checkout_id,
                &staged.status_token,
                &format!("{failure} failure"),
            )
            .unwrap();
        if failure == "identity" {
            fixture.git(fixture.root(), &["config", "user.name", ""]);
            fixture.git(fixture.root(), &["config", "user.email", ""]);
        } else {
            let hook = fixture.root().join(".git/hooks/pre-commit");
            std::fs::write(&hook, "#!/bin/sh\necho rejected-by-test >&2\nexit 1\n").unwrap();
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let before = fixture.git(fixture.root(), &["rev-parse", "HEAD"]);
        fixture.record_write_target(&format!("commit {failure} failure"), fixture.root());
        let result = manager
            .commit_changes(
                &locator,
                &review.context.checkout_id,
                &review.commit_token,
                &review.message,
            )
            .unwrap();
        assert_eq!(result.outcome, GitCommitOutcome::NotExecuted);
        assert_eq!(fixture.git(fixture.root(), &["rev-parse", "HEAD"]), before);
        assert!(fixture
            .git(fixture.root(), &["diff", "--cached", "--name-only"])
            .lines()
            .any(|path| path == "tracked.txt"));
        assert!(result.error.is_some());
        fixture.assert_recorded_write_targets_are_isolated();
    }
}

#[test]
fn commit_in_one_worktree_does_not_move_main_or_sibling_head_or_index() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let wt_a = fixture.add_worktree(&db, "project-a", "wt-a", "feature/commit-a");
    let wt_b = fixture.add_worktree(&db, "project-a", "wt-b", "feature/commit-b");
    std::fs::write(wt_a.join("tracked.txt"), "commit only A\n").unwrap();
    let locator = GitContextLocator::Worktree {
        project_id: "project-a".into(),
        worktree_id: "wt-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let before_main = fixture.git(fixture.root(), &["rev-parse", "HEAD"]);
    let before_a = fixture.git(&wt_a, &["rev-parse", "HEAD"]);
    let before_b = fixture.git(&wt_b, &["rev-parse", "HEAD"]);
    let changes = manager.changes(&locator, true).unwrap();
    let entry = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "tracked.txt")
        .unwrap();
    fixture.record_write_target("stage wt-a commit", &wt_a);
    let staged = manager
        .stage_paths(
            &locator,
            &changes.context.checkout_id,
            &changes.status_token,
            &[GitPathSelection {
                path_token: entry.path_token.clone(),
                entry_token: entry.entry_token.clone(),
            }],
        )
        .unwrap()
        .changes;
    let review = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            "commit only worktree A",
        )
        .unwrap();
    fixture.record_write_target("commit wt-a", &wt_a);
    let result = manager
        .commit_changes(
            &locator,
            &review.context.checkout_id,
            &review.commit_token,
            &review.message,
        )
        .unwrap();
    assert_eq!(result.outcome, GitCommitOutcome::Succeeded);
    assert_ne!(fixture.git(&wt_a, &["rev-parse", "HEAD"]), before_a);
    assert_eq!(
        fixture.git(fixture.root(), &["rev-parse", "HEAD"]),
        before_main
    );
    assert_eq!(fixture.git(&wt_b, &["rev-parse", "HEAD"]), before_b);
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
fn startup_recovery_classifies_committed_and_unexecuted_journals_from_git_truth() {
    use chrono::{SecondsFormat, Utc};
    use rusqlite::params;

    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "recovery scope\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let staged = stage_tracked(&fixture, &manager, &locator);
    let review = manager
        .prepare_commit(
            &locator,
            &staged.context.checkout_id,
            &staged.status_token,
            "recover exact commit",
        )
        .unwrap();
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let insert_journal = |id: &str| {
        db.conn()
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO git_commit_operations(
                    id,project_id,worktree_id,repo_key,checkout_id,checkout_root,before_head,
                    expected_tree_oid,index_hash,message_hash,phase,created_at,updated_at
                 ) VALUES(?1,?2,NULL,?3,?4,?5,?6,?7,?8,?9,'started',?10,?10)",
                params![
                    id,
                    "project-a",
                    review.context.repo_key,
                    review.context.checkout_id,
                    review.context.checkout_root,
                    review.before_head,
                    review.expected_tree_oid,
                    review.index_hash,
                    review.message_hash,
                    now,
                ],
            )
            .unwrap();
    };
    insert_journal("journal-not-executed");
    assert!(matches!(
        db.remove_project("project-a"),
        Err(agentport_core::CoreError::Blocked(_))
    ));
    let first = manager.reconcile_commit_operations().unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].outcome, GitCommitOutcome::NotExecuted);

    insert_journal("journal-succeeded");
    fixture.record_write_target("external fixture commit for recovery", fixture.root());
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "recover exact commit",
        ],
    );
    let second = manager.reconcile_commit_operations().unwrap();
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].operation_id, "journal-succeeded");
    assert_eq!(second[0].outcome, GitCommitOutcome::Succeeded);
    assert_eq!(second[0].repo_key, review.context.repo_key);
    assert_eq!(second[0].checkout_id, review.context.checkout_id);
    let stored_hash: String = db
        .conn()
        .lock()
        .unwrap()
        .query_row(
            "SELECT message_hash FROM git_commit_operations WHERE id='journal-succeeded'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(stored_hash, review.message);
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn review_warns_when_a_rename_touches_a_path_outside_the_project_directory() {
    let fixture = MockRepo::new();
    fixture.write("outside-old.txt", "outside project\n");
    fixture.git(fixture.root(), &["add", "--", "outside-old.txt"]);
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "outside baseline",
        ],
    );
    std::fs::create_dir(fixture.root().join("app")).unwrap();
    fixture.git(
        fixture.root(),
        &["mv", "--", "outside-old.txt", "app/moved-inside.txt"],
    );

    let db = Db::open_memory().unwrap();
    db.add_project(&Project {
        id: "project-subdir".into(),
        name: "Subdirectory Project".into(),
        root_path: fixture.root().join("app").to_string_lossy().into_owned(),
        git_root_path: Some(fixture.root().to_string_lossy().into_owned()),
        created_at: Utc::now(),
    })
    .unwrap();
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-subdir".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    let review = manager
        .prepare_commit(
            &locator,
            &changes.context.checkout_id,
            &changes.status_token,
            "move file into project",
        )
        .unwrap();

    assert_eq!(review.files.len(), 1);
    assert_eq!(
        review.files[0].display_old_path.as_deref(),
        Some("outside-old.txt")
    );
    assert!(review.files[0].outside_project);
    assert_eq!(review.outside_project_paths, vec!["outside-old.txt"]);
    assert!(review
        .warnings
        .iter()
        .any(|warning| warning == "outside_project_scope"));
}
