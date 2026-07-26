mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitChangeKind, GitContextLocator, GitWorkspaceManager};
use support::mock_repo::MockRepo;

#[test]
fn changes_reports_file_level_staged_unstaged_untracked_ignored_and_rename() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");

    fixture.write(".gitignore", "ignored/\n");
    fixture.write("rename-old.txt", "rename base\n");
    fixture.git(
        fixture.root(),
        &["add", "--", ".gitignore", "rename-old.txt"],
    );
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "fixture files",
        ],
    );

    fixture.write("tracked.txt", "staged\n");
    fixture.git(fixture.root(), &["add", "--", "tracked.txt"]);
    fixture.write("tracked.txt", "working\n");
    fixture.write("untracked ü.txt", "new\n");
    fixture.write("ignored/secret.txt", "ignored\n");
    fixture.git(
        fixture.root(),
        &["mv", "--", "rename-old.txt", "rename-new.txt"],
    );

    let snapshot = GitWorkspaceManager::new(&db)
        .changes(
            &GitContextLocator::ProjectMain {
                project_id: "project-a".into(),
            },
            true,
        )
        .unwrap();

    assert!(snapshot.complete, "{:?}", snapshot.partial_reason);
    let mixed = snapshot
        .entries
        .iter()
        .find(|entry| entry.display_path == "tracked.txt")
        .unwrap();
    assert!(mixed.staged && mixed.unstaged);
    assert!(snapshot
        .entries
        .iter()
        .any(|entry| entry.untracked && entry.display_path == "untracked ü.txt"));
    assert!(snapshot
        .entries
        .iter()
        .any(|entry| entry.ignored && entry.display_path.starts_with("ignored/")));
    let renamed = snapshot
        .entries
        .iter()
        .find(|entry| entry.display_path == "rename-new.txt")
        .unwrap();
    assert!(renamed.staged);
    assert_eq!(renamed.display_old_path.as_deref(), Some("rename-old.txt"));
    assert!(!snapshot.status_token.is_empty());
    assert!(snapshot
        .entries
        .iter()
        .all(|entry| { !entry.path_token.is_empty() && !entry.entry_token.is_empty() }));
}

#[cfg(unix)]
#[test]
fn changes_preserves_special_non_utf8_paths_and_symlink_identity() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::symlink;

    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let non_utf8 = fixture.root().join(OsStr::from_bytes(b"non-utf8-\xff.txt"));
    let non_utf8_created = match std::fs::write(&non_utf8, b"opaque path\n") {
        Ok(()) => true,
        // APFS rejects some byte sequences even though Git's protocol and the
        // backend parser must remain byte-safe for other Unix filesystems.
        Err(error) if error.raw_os_error() == Some(92) => false,
        Err(error) => panic!("create non-UTF8 fixture: {error}"),
    };
    fixture.write("line\nbreak.txt", "newline path\n");
    symlink("/etc/passwd", fixture.root().join("escape-link")).unwrap();

    let snapshot = GitWorkspaceManager::new(&db)
        .changes(
            &GitContextLocator::ProjectMain {
                project_id: "project-a".into(),
            },
            true,
        )
        .unwrap();

    assert!(snapshot.complete);
    if non_utf8_created {
        assert!(snapshot.entries.iter().any(|entry| {
            entry.untracked
                && entry.display_path.starts_with("non-utf8-")
                && entry.display_path.ends_with(".txt")
        }));
    }
    assert!(snapshot
        .entries
        .iter()
        .any(|entry| entry.untracked && entry.display_path == "line\nbreak.txt"));
    let symlink = snapshot
        .entries
        .iter()
        .find(|entry| entry.display_path == "escape-link")
        .unwrap();
    assert_eq!(symlink.kind, GitChangeKind::Untracked);
    assert!(!symlink.path_token.contains("/etc/passwd"));
}

#[test]
fn changes_retains_real_conflict_code() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.git(fixture.root(), &["branch", "conflict-side"]);
    let side = fixture.workspace().join("conflict-side-checkout");
    fixture.git(
        fixture.root(),
        &["worktree", "add", side.to_str().unwrap(), "conflict-side"],
    );

    fixture.write("tracked.txt", "main side\n");
    fixture.git(fixture.root(), &["add", "--", "tracked.txt"]);
    fixture.git(
        fixture.root(),
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "main conflict side",
        ],
    );
    std::fs::write(side.join("tracked.txt"), "branch side\n").unwrap();
    fixture.git(&side, &["add", "--", "tracked.txt"]);
    fixture.git(
        &side,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "branch conflict side",
        ],
    );
    let merge = fixture.git_output(fixture.root(), &["merge", "conflict-side"]);
    assert!(!merge.status.success(), "fixture merge must conflict");

    let snapshot = GitWorkspaceManager::new(&db)
        .changes(
            &GitContextLocator::ProjectMain {
                project_id: "project-a".into(),
            },
            true,
        )
        .unwrap();
    let conflict = snapshot
        .entries
        .iter()
        .find(|entry| entry.display_path == "tracked.txt")
        .unwrap();
    assert!(conflict.conflicted);
    assert_eq!(conflict.conflict_code.as_deref(), Some("UU"));
    assert_eq!(snapshot.counts.conflict, 1);
}
