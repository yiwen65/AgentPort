mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitContextLocator, GitRemoteAction, GitWorkspaceManager};
use agentport_core::CoreError;
use std::process::{Command, Stdio};
use support::mock_repo::MockRepo;

fn git(cwd: &std::path::Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn descriptor_exposes_the_configured_remote_url() {
    let fixture = MockRepo::new();
    fixture.git(
        fixture.root(),
        &["remote", "add", "origin", "git@github.com:owner/repo.git"],
    );

    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);

    let context = manager.resolve(&locator).unwrap();
    assert_eq!(
        context.remote_url.as_deref(),
        Some("git@github.com:owner/repo.git")
    );

    fixture.git(fixture.root(), &["remote", "remove", "origin"]);
    let without_remote = manager.resolve(&locator).unwrap();
    assert_eq!(without_remote.remote_url, None);
}

#[test]
fn remote_status_tracks_ahead_and_push_updates_the_upstream() {
    let fixture = MockRepo::new();
    let bare = fixture.workspace().join("origin.git");
    Command::new("git")
        .args(["init", "--bare", bare.to_str().unwrap()])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    fixture.git(
        fixture.root(),
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    fixture.git(fixture.root(), &["push", "-u", "origin", "main"]);
    fixture.write("tracked.txt", "ahead\n");
    fixture.git(fixture.root(), &["add", "--", "tracked.txt"]);
    fixture.git(
        fixture.root(),
        &["-c", "commit.gpgsign=false", "commit", "-m", "ahead"],
    );

    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let before = manager.changes(&locator, true).unwrap();
    assert_eq!(before.context.upstream.as_deref(), Some("origin/main"));
    assert_eq!(before.context.ahead, 1);
    assert_eq!(before.context.behind, 0);

    fixture.record_write_target("push current branch", fixture.root());
    let pushed = manager
        .sync_remote(
            &locator,
            &before.context.checkout_id,
            &before.status_token,
            GitRemoteAction::Push,
        )
        .unwrap();
    assert_eq!(pushed.changes.context.ahead, 0);
    assert_eq!(
        git(&bare, &["rev-parse", "refs/heads/main"]).trim(),
        fixture.git(fixture.root(), &["rev-parse", "HEAD"]).trim()
    );

    let peer = fixture.workspace().join("peer");
    git(
        fixture.workspace(),
        &["clone", bare.to_str().unwrap(), peer.to_str().unwrap()],
    );
    git(&peer, &["config", "user.name", "Remote Peer"]);
    git(&peer, &["config", "user.email", "peer@test.invalid"]);
    std::fs::write(peer.join("tracked.txt"), "from peer\n").unwrap();
    git(&peer, &["add", "--", "tracked.txt"]);
    git(
        &peer,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "remote update",
        ],
    );
    git(&peer, &["push", "origin", "main"]);

    fixture.record_write_target("fetch remote branch", fixture.root());
    let fetched = manager
        .sync_remote(
            &locator,
            &pushed.changes.context.checkout_id,
            &pushed.changes.status_token,
            GitRemoteAction::Fetch,
        )
        .unwrap();
    assert_eq!(fetched.changes.context.behind, 1);

    fixture.record_write_target("pull remote branch", fixture.root());
    let pulled = manager
        .sync_remote(
            &locator,
            &fetched.changes.context.checkout_id,
            &fetched.changes.status_token,
            GitRemoteAction::Pull,
        )
        .unwrap();
    assert_eq!(pulled.changes.context.behind, 0);
    assert_eq!(
        std::fs::read_to_string(fixture.root().join("tracked.txt")).unwrap(),
        "from peer\n"
    );
    fixture.assert_recorded_write_targets_are_isolated();
}

#[test]
fn pull_is_blocked_when_the_checkout_has_local_changes_and_main_cannot_force_push() {
    let fixture = MockRepo::new();
    let bare = fixture.workspace().join("origin.git");
    Command::new("git")
        .args(["init", "--bare", bare.to_str().unwrap()])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    fixture.git(
        fixture.root(),
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    fixture.git(fixture.root(), &["push", "-u", "origin", "main"]);
    fixture.write("tracked.txt", "dirty\n");

    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let dirty = manager.changes(&locator, true).unwrap();

    let pull = manager
        .sync_remote(
            &locator,
            &dirty.context.checkout_id,
            &dirty.status_token,
            GitRemoteAction::PullRebase,
        )
        .unwrap_err();
    assert!(matches!(pull, CoreError::Blocked(_)), "{pull}");

    let force = manager
        .sync_remote(
            &locator,
            &dirty.context.checkout_id,
            &dirty.status_token,
            GitRemoteAction::ForcePush,
        )
        .unwrap_err();
    assert!(matches!(force, CoreError::Blocked(_)), "{force}");
}

#[test]
fn explicit_autostash_pull_preserves_staged_changes_while_updating_the_branch() {
    let fixture = MockRepo::new();
    let bare = fixture.workspace().join("origin.git");
    Command::new("git")
        .args(["init", "--bare", bare.to_str().unwrap()])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    fixture.git(
        fixture.root(),
        &["remote", "add", "origin", bare.to_str().unwrap()],
    );
    fixture.git(fixture.root(), &["push", "-u", "origin", "main"]);

    let peer = fixture.workspace().join("peer");
    git(
        fixture.workspace(),
        &["clone", bare.to_str().unwrap(), peer.to_str().unwrap()],
    );
    git(&peer, &["config", "user.name", "Remote Peer"]);
    git(&peer, &["config", "user.email", "peer@test.invalid"]);
    std::fs::write(peer.join("remote.txt"), "from remote\n").unwrap();
    git(&peer, &["add", "--", "remote.txt"]);
    git(
        &peer,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "remote update",
        ],
    );
    git(&peer, &["push", "origin", "main"]);

    fixture.write("local.txt", "local staged work\n");
    fixture.git(fixture.root(), &["add", "--", "local.txt"]);

    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let locator = GitContextLocator::ProjectMain {
        project_id: "project-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let dirty = manager.changes(&locator, true).unwrap();

    fixture.record_write_target("pull with explicit auto-stash", fixture.root());
    let pulled = manager
        .sync_remote(
            &locator,
            &dirty.context.checkout_id,
            &dirty.status_token,
            GitRemoteAction::PullAutostash,
        )
        .unwrap();

    assert_eq!(pulled.changes.context.behind, 0);
    assert_eq!(
        std::fs::read_to_string(fixture.root().join("remote.txt")).unwrap(),
        "from remote\n"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root().join("local.txt")).unwrap(),
        "local staged work\n"
    );
    assert!(
        pulled
            .changes
            .entries
            .iter()
            .any(|entry| entry.display_path == "local.txt" && entry.staged),
        "the staged local file must remain staged after Pull"
    );
    assert!(git(fixture.root(), &["stash", "list"]).trim().is_empty());
    fixture.assert_recorded_write_targets_are_isolated();
}
