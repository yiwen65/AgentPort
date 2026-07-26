mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitContextLocator, GitDiffFormat, GitDiffSide, GitWorkspaceManager};
use support::mock_repo::MockRepo;

#[test]
fn diff_keeps_staged_unstaged_and_untracked_semantics_separate() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", "staged value\n");
    fixture.git(fixture.root(), &["add", "--", "tracked.txt"]);
    fixture.write("tracked.txt", "working value\n");
    fixture.write("new.txt", "first\nsecond\n");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    let tracked = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "tracked.txt")
        .unwrap();
    let untracked = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "new.txt")
        .unwrap();

    let staged = manager
        .diff(
            &locator,
            &changes.status_token,
            GitDiffSide::Staged,
            &tracked.path_token,
        )
        .unwrap();
    let unstaged = manager
        .diff(
            &locator,
            &changes.status_token,
            GitDiffSide::Unstaged,
            &tracked.path_token,
        )
        .unwrap();
    let new_file = manager
        .diff(
            &locator,
            &changes.status_token,
            GitDiffSide::Unstaged,
            &untracked.path_token,
        )
        .unwrap();

    assert_eq!(staged.format, GitDiffFormat::Text);
    assert!(staged.patch.as_deref().unwrap().contains("+staged value"));
    assert!(!staged.patch.as_deref().unwrap().contains("+working value"));
    assert!(unstaged
        .patch
        .as_deref()
        .unwrap()
        .contains("+working value"));
    assert!(new_file.patch.as_deref().unwrap().contains("+first"));
    assert_eq!(new_file.additions, Some(2));
}

#[test]
fn binary_and_large_untracked_files_degrade_without_returning_full_content() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("binary.bin", b"binary\0payload");
    fixture.write("large.txt", vec![b'x'; 1024 * 1024 + 64]);
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();

    let binary = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "binary.bin")
        .unwrap();
    let binary_diff = manager
        .diff(
            &locator,
            &changes.status_token,
            GitDiffSide::Unstaged,
            &binary.path_token,
        )
        .unwrap();
    assert_eq!(binary_diff.format, GitDiffFormat::Binary);
    assert!(binary_diff.patch.is_none());

    let large = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "large.txt")
        .unwrap();
    let large_diff = manager
        .diff(
            &locator,
            &changes.status_token,
            GitDiffSide::Unstaged,
            &large.path_token,
        )
        .unwrap();
    assert_eq!(large_diff.format, GitDiffFormat::Summary);
    assert!(large_diff.truncated);
    assert!(large_diff.patch.is_none());
}

#[test]
fn large_tracked_diff_is_explicitly_truncated() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("tracked.txt", vec![b'x'; 1024 * 1024 + 128]);
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    let entry = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "tracked.txt")
        .unwrap();

    let diff = manager
        .diff(
            &locator,
            &changes.status_token,
            GitDiffSide::Unstaged,
            &entry.path_token,
        )
        .unwrap();
    assert_eq!(diff.format, GitDiffFormat::Text);
    assert!(diff.truncated);
    assert_eq!(diff.reason.as_deref(), Some("diff_limit"));
    assert!(diff
        .patch
        .as_ref()
        .is_some_and(|patch| patch.len() <= 1024 * 1024));
}

#[cfg(unix)]
#[test]
fn untracked_symlink_is_never_followed_for_preview() {
    use std::os::unix::fs::symlink;

    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    symlink("/etc/passwd", fixture.root().join("escape-link")).unwrap();
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let changes = manager.changes(&locator, true).unwrap();
    let entry = changes
        .entries
        .iter()
        .find(|entry| entry.display_path == "escape-link")
        .unwrap();

    let diff = manager
        .diff(
            &locator,
            &changes.status_token,
            GitDiffSide::Unstaged,
            &entry.path_token,
        )
        .unwrap();
    assert_eq!(diff.format, GitDiffFormat::Summary);
    assert_eq!(diff.reason.as_deref(), Some("symlink_no_follow"));
    assert!(diff.patch.is_none());
}

#[test]
fn conflict_preview_is_labeled_and_path_tokens_cannot_cross_worktrees() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.git(fixture.root(), &["branch", "conflict-side"]);
    let side = fixture.workspace().join("conflict-preview-side");
    fixture.git(
        fixture.root(),
        &["worktree", "add", side.to_str().unwrap(), "conflict-side"],
    );
    fixture.write("tracked.txt", "main preview\n");
    fixture.git(fixture.root(), &["add", "--", "tracked.txt"]);
    fixture.git(
        fixture.root(),
        &["-c", "commit.gpgsign=false", "commit", "-m", "main preview"],
    );
    std::fs::write(side.join("tracked.txt"), "side preview\n").unwrap();
    fixture.git(&side, &["add", "--", "tracked.txt"]);
    fixture.git(
        &side,
        &["-c", "commit.gpgsign=false", "commit", "-m", "side preview"],
    );
    assert!(!fixture
        .git_output(fixture.root(), &["merge", "conflict-side"])
        .status
        .success());

    let main_locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let main_changes = manager.changes(&main_locator, true).unwrap();
    let conflict = main_changes
        .entries
        .iter()
        .find(|entry| entry.conflicted)
        .unwrap();
    let conflict_diff = manager
        .diff(
            &main_locator,
            &main_changes.status_token,
            GitDiffSide::Unstaged,
            &conflict.path_token,
        )
        .unwrap();
    assert_eq!(conflict_diff.format, GitDiffFormat::Conflict);
    assert_eq!(conflict_diff.conflict_code.as_deref(), Some("UU"));

    let worktree = fixture.add_worktree(&db, "project-a", "wt-token", "feature/token");
    std::fs::write(worktree.join("tracked.txt"), "worktree token\n").unwrap();
    let worktree_locator = GitContextLocator::Worktree {
        project_id: "project-a".into(),
        worktree_id: "wt-token".into(),
    };
    let worktree_changes = manager.changes(&worktree_locator, true).unwrap();
    let error = manager
        .diff(
            &worktree_locator,
            &worktree_changes.status_token,
            GitDiffSide::Unstaged,
            &conflict.path_token,
        )
        .unwrap_err();
    assert!(matches!(error, agentport_core::CoreError::Validation(_)));
}
