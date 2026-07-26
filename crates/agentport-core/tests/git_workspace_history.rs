mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitContextLocator, GitDiffFormat, GitWorkspaceManager};
use support::mock_repo::MockRepo;

#[test]
fn history_pagination_stays_anchored_when_head_changes() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    for index in 0..125 {
        fixture.write("counter.txt", format!("{index}\n"));
        fixture.git(fixture.root(), &["add", "--", "counter.txt"]);
        fixture.git(
            fixture.root(),
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                &format!("commit {index:03}"),
            ],
        );
    }
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let first = manager.history(&locator, None, 50).unwrap();
    assert_eq!(first.commits.len(), 50);
    assert!(!first.head_changed);
    let original_anchor = first.anchor_oid.clone().unwrap();
    fixture.add_worktree(&db, "project-a", "wt-history", "feature/history");
    let cross_checkout = manager
        .history(
            &GitContextLocator::Worktree {
                project_id: "project-a".into(),
                worktree_id: "wt-history".into(),
            },
            first.next_cursor.as_deref(),
            50,
        )
        .unwrap_err();
    assert!(matches!(
        cross_checkout,
        agentport_core::CoreError::Validation(_)
    ));

    fixture.write("counter.txt", "new head\n");
    fixture.git(fixture.root(), &["add", "--", "counter.txt"]);
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "new head after paging",
        ],
    );

    let second = manager
        .history(&locator, first.next_cursor.as_deref(), 50)
        .unwrap();
    assert!(second.head_changed);
    assert_eq!(second.anchor_oid.as_deref(), Some(original_anchor.as_str()));
    assert_eq!(second.commits.len(), 50);
    assert!(first
        .commits
        .iter()
        .all(|left| second.commits.iter().all(|right| left.oid != right.oid)));
}

#[test]
fn root_commit_detail_and_diff_are_available() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let page = manager.history(&locator, None, 50).unwrap();
    let root = page.commits.last().unwrap();
    let detail = manager.commit_detail(&locator, &root.oid).unwrap();

    assert!(detail.commit.parent_oids.is_empty());
    assert!(detail
        .files
        .iter()
        .any(|file| file.display_path == "tracked.txt"));
    let diff = manager
        .commit_diff(&locator, &root.oid, None, None)
        .unwrap();
    assert_eq!(diff.format, GitDiffFormat::Text);
    assert!(diff.patch.as_deref().unwrap().contains("+base"));
}

#[test]
fn merge_commit_defaults_to_first_parent_and_accepts_only_real_parents() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.git(fixture.root(), &["branch", "merge-side"]);
    let side = fixture.workspace().join("merge-side-checkout");
    fixture.git(
        fixture.root(),
        &["worktree", "add", side.to_str().unwrap(), "merge-side"],
    );

    fixture.write("main-only.txt", "main\n");
    fixture.git(fixture.root(), &["add", "--", "main-only.txt"]);
    fixture.git(
        fixture.root(),
        &["-c", "commit.gpgsign=false", "commit", "-m", "main parent"],
    );
    std::fs::write(side.join("side-only.txt"), "side\n").unwrap();
    fixture.git(&side, &["add", "--", "side-only.txt"]);
    fixture.git(
        &side,
        &["-c", "commit.gpgsign=false", "commit", "-m", "side parent"],
    );
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "merge",
            "--no-ff",
            "-m",
            "merge fixture",
            "merge-side",
        ],
    );

    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let merge_oid = fixture
        .git(fixture.root(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let detail = manager.commit_detail(&locator, &merge_oid).unwrap();
    assert_eq!(detail.commit.parent_oids.len(), 2);
    assert_eq!(
        detail.selected_parent_oid.as_deref(),
        detail.commit.parent_oids.first().map(String::as_str)
    );
    let second_parent = detail.commit.parent_oids[1].clone();
    let second_parent_diff = manager
        .commit_diff(&locator, &merge_oid, Some(&second_parent), None)
        .unwrap();
    assert_eq!(
        second_parent_diff.parent_oid.as_deref(),
        Some(second_parent.as_str())
    );
    assert!(second_parent_diff
        .patch
        .as_deref()
        .is_some_and(|patch| patch.contains("main-only.txt")));

    let unrelated = fixture
        .git(fixture.root(), &["rev-list", "--max-parents=0", "HEAD"])
        .trim()
        .to_owned();
    assert!(!detail
        .commit
        .parent_oids
        .iter()
        .any(|oid| oid == &unrelated));
    let error = manager
        .commit_diff(&locator, &merge_oid, Some(&unrelated), None)
        .unwrap_err();
    assert!(matches!(error, agentport_core::CoreError::Validation(_)));
}

#[test]
fn mixed_commit_keeps_text_diff_while_selected_binary_file_degrades() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.write("readable.txt", "visible text\n");
    fixture.write("image.bin", [0_u8, 1, 2, 3, 0xff]);
    fixture.git(fixture.root(), &["add", "--", "readable.txt", "image.bin"]);
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "mixed text and binary",
        ],
    );

    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let oid = fixture
        .git(fixture.root(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let detail = manager.commit_detail(&locator, &oid).unwrap();
    let binary = detail
        .files
        .iter()
        .find(|file| file.display_path == "image.bin")
        .unwrap();
    assert!(binary.binary);

    let all = manager.commit_diff(&locator, &oid, None, None).unwrap();
    assert_eq!(all.format, GitDiffFormat::Text);
    assert!(all
        .patch
        .as_deref()
        .is_some_and(|patch| patch.contains("visible text")));

    let selected = manager
        .commit_diff(&locator, &oid, None, Some(&binary.path_token))
        .unwrap();
    assert_eq!(selected.format, GitDiffFormat::Binary);
    assert!(selected.patch.is_none());
}

#[test]
fn selected_rename_diff_binds_the_old_and_new_paths_to_the_commit() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.git(fixture.root(), &["mv", "tracked.txt", "renamed.txt"]);
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "rename tracked file",
        ],
    );

    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let oid = fixture
        .git(fixture.root(), &["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let detail = manager.commit_detail(&locator, &oid).unwrap();
    let renamed = detail
        .files
        .iter()
        .find(|file| file.display_path == "renamed.txt")
        .unwrap();
    assert_eq!(renamed.display_old_path.as_deref(), Some("tracked.txt"));

    let patch = manager
        .commit_diff(&locator, &oid, None, Some(&renamed.path_token))
        .unwrap();
    assert_eq!(patch.format, GitDiffFormat::Text);
    let text = patch.patch.as_deref().unwrap();
    assert!(text.contains("rename from tracked.txt"), "{text}");
    assert!(text.contains("rename to renamed.txt"), "{text}");
}
