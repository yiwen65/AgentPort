use agentport_core::db::Db;
use agentport_core::git::{
    BranchManager, BranchOperationPhase, GitRunner, RepositoryFileLock, RepositoryIdentity,
    RestoreStrategy,
};
use agentport_core::models::Project;
use agentport_core::CoreError;
use chrono::Utc;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LOCK_PROBE_COMMON_DIR: &str = "AGENTPORT_TEST_LOCK_PROBE_COMMON_DIR";

struct Fixture {
    _temp: tempfile::TempDir,
    root: PathBuf,
    db: Db,
    project_id: String,
}

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let raw = temp.path().join("branch safety repo ü");
    std::fs::create_dir(&raw).unwrap();
    git(&raw, &["init", "-b", "main"]);
    git(&raw, &["config", "user.name", "AgentPort Safety"]);
    git(
        &raw,
        &["config", "user.email", "agentport-safety@test.invalid"],
    );
    std::fs::write(raw.join("tracked.txt"), "base\n").unwrap();
    std::fs::write(raw.join("old name ü.txt"), "rename base\n").unwrap();
    git(&raw, &["add", "--", "tracked.txt", "old name ü.txt"]);
    git(
        &raw,
        &["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
    );
    git(&raw, &["branch", "target"]);

    let root = std::fs::canonicalize(raw).unwrap();
    let db = Db::open_memory().unwrap();
    let project_id = "safety_project".to_owned();
    db.add_project(&Project {
        id: project_id.clone(),
        name: "Safety".into(),
        root_path: root.to_string_lossy().into_owned(),
        git_root_path: Some(root.to_string_lossy().into_owned()),
        created_at: Utc::now(),
        pinned: false,
        sort_order: 0,
    })
    .unwrap();
    Fixture {
        _temp: temp,
        root,
        db,
        project_id,
    }
}

fn stash_oids(root: &Path) -> Vec<String> {
    git(root, &["stash", "list", "--format=%H"])
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn porcelain_v2_rename_round_trips_worktree_and_staged_index() {
    let fixture = fixture();
    let old = "old name ü.txt";
    let new = "new name ü.txt";
    git(&fixture.root, &["mv", "--", old, new]);
    let staged_tree_before = git(&fixture.root, &["write-tree"]);
    let staged_blob_before = git(&fixture.root, &["rev-parse", &format!(":{new}")]);
    std::fs::write(fixture.root.join(new), "unstaged rename contents\n").unwrap();
    let worktree_before = std::fs::read(fixture.root.join(new)).unwrap();

    let manager = BranchManager::new(&fixture.db);
    let status = manager.list(&fixture.project_id).unwrap().status;
    let renamed = status
        .paths
        .iter()
        .find(|path| path.path == new)
        .expect("porcelain v2 type-2 path must exclude the R100 score field");
    assert!(renamed.staged && renamed.unstaged && !renamed.untracked);

    let switched = manager.switch(&fixture.project_id, "target").unwrap();
    let restored = manager
        .recover(&switched.operation_id, RestoreStrategy::Target)
        .unwrap();
    assert_eq!(restored.phase, BranchOperationPhase::RestoredVerified);
    assert_eq!(git(&fixture.root, &["write-tree"]), staged_tree_before);
    assert_eq!(
        git(&fixture.root, &["rev-parse", &format!(":{new}")]),
        staged_blob_before
    );
    assert_eq!(
        std::fs::read(fixture.root.join(new)).unwrap(),
        worktree_before
    );
    assert!(!fixture.root.join(old).exists());
}

#[test]
fn cleanup_is_blocked_if_verified_restored_files_change_and_stash_is_retained() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("tracked.txt"), "protected dirty\n").unwrap();
    let manager = BranchManager::new(&fixture.db);
    let switched = manager.switch(&fixture.project_id, "target").unwrap();
    manager
        .recover(&switched.operation_id, RestoreStrategy::Target)
        .unwrap();
    let stash_oid = manager
        .operation(&switched.operation_id)
        .unwrap()
        .stash_oid
        .unwrap();

    std::fs::write(
        fixture.root.join("tracked.txt"),
        "protected dirty plus later edit\n",
    )
    .unwrap();
    let error = manager.cleanup(&switched.operation_id).unwrap_err();
    assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    assert_eq!(
        manager.operation(&switched.operation_id).unwrap().phase,
        BranchOperationPhase::RestoredVerified
    );
    assert!(stash_oids(&fixture.root)
        .iter()
        .any(|oid| oid == &stash_oid));
}

#[test]
fn cleanup_never_deletes_from_a_shared_stash_reflog() {
    let fixture = fixture();
    std::fs::write(fixture.root.join("tracked.txt"), "protected dirty\n").unwrap();
    let manager = BranchManager::new(&fixture.db);
    let switched = manager.switch(&fixture.project_id, "target").unwrap();
    let agentport_oid = manager
        .operation(&switched.operation_id)
        .unwrap()
        .stash_oid
        .unwrap();

    // Put a real external stash above AgentPort's entry before recovery. The
    // restore must apply the persisted OID, never the now-stale stash@{0}.
    std::fs::write(fixture.root.join("external-only.txt"), "external\n").unwrap();
    git(
        &fixture.root,
        &[
            "stash",
            "push",
            "--include-untracked",
            "-m",
            "external-backup",
        ],
    );
    let before = stash_oids(&fixture.root);
    assert_eq!(before.len(), 2);
    let external_oid = before[0].clone();
    assert!(before.iter().any(|oid| oid == &agentport_oid));
    assert_ne!(external_oid, agentport_oid);

    manager
        .recover(&switched.operation_id, RestoreStrategy::Target)
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
        "protected dirty\n"
    );
    assert!(!fixture.root.join("external-only.txt").exists());
    assert_eq!(stash_oids(&fixture.root), before);

    let error = manager.cleanup(&switched.operation_id).unwrap_err();
    assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    assert_eq!(stash_oids(&fixture.root), before);
    assert_eq!(
        manager.operation(&switched.operation_id).unwrap().phase,
        BranchOperationPhase::RestoredVerified
    );
}

#[test]
fn prepared_restart_with_snapshot_drift_requires_recovery() {
    let fixture = fixture();
    std::fs::write(
        fixture.root.join("tracked.txt"),
        "original protected dirty\n",
    )
    .unwrap();
    let manager = BranchManager::new(&fixture.db);
    let switched = manager.switch(&fixture.project_id, "target").unwrap();
    manager
        .recover(&switched.operation_id, RestoreStrategy::Source)
        .unwrap();
    manager.cleanup(&switched.operation_id).unwrap();

    // Model a restart after a prepared journal write but with no discoverable
    // stash and a worktree that no longer matches the persisted pre-op image.
    std::fs::write(
        fixture.root.join("tracked.txt"),
        "unexpected external drift\n",
    )
    .unwrap();
    {
        let conn = fixture.db.conn().lock().unwrap();
        conn.execute(
            "UPDATE branch_operations
             SET phase='prepared',stash_oid=NULL,stash_selector=NULL,error_json=NULL,completed_at=NULL
             WHERE id=?1",
            rusqlite::params![switched.operation_id],
        )
        .unwrap();
    }

    let restarted = BranchManager::new(&fixture.db);
    let report = restarted.reconcile(&fixture.project_id).unwrap();
    let reconciled = restarted.operation(&switched.operation_id).unwrap();
    assert_eq!(reconciled.phase, BranchOperationPhase::RecoveryRequired);
    assert!(report
        .incomplete
        .iter()
        .any(|operation| operation.id == switched.operation_id));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
        "unexpected external drift\n"
    );
}

#[test]
fn common_dir_file_lock_serializes_independent_handles() {
    let fixture = fixture();
    let identity = RepositoryIdentity::discover(&fixture.root, &GitRunner::default()).unwrap();
    let first =
        RepositoryFileLock::acquire_with_timeout(&identity.common_dir, Duration::from_secs(1))
            .unwrap();

    std::thread::scope(|scope| {
        let common_dir = identity.common_dir.clone();
        let waiter = scope.spawn(move || {
            RepositoryFileLock::acquire_with_timeout(&common_dir, Duration::from_millis(60))
        });
        let error = match waiter.join().unwrap() {
            Ok(_) => panic!("second independent file-lock handle unexpectedly acquired the lock"),
            Err(error) => error,
        };
        assert!(matches!(error, CoreError::Timeout(_)), "{error}");
    });

    let child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "repository_file_lock_child_probe", "--nocapture"])
        .env(LOCK_PROBE_COMMON_DIR, &identity.common_dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        child.status.success(),
        "cross-process lock probe failed: {}",
        String::from_utf8_lossy(&child.stderr)
    );

    drop(first);
    RepositoryFileLock::acquire_with_timeout(&identity.common_dir, Duration::from_secs(1)).unwrap();
}

#[test]
fn repository_file_lock_child_probe() {
    let Some(common_dir) = std::env::var_os(LOCK_PROBE_COMMON_DIR) else {
        return;
    };
    let result =
        RepositoryFileLock::acquire_with_timeout(Path::new(&common_dir), Duration::from_millis(80));
    match result {
        Err(CoreError::Timeout(_)) => {}
        Err(error) => panic!("cross-process lock probe returned the wrong error: {error}"),
        Ok(_) => panic!("cross-process lock probe unexpectedly acquired a held lock"),
    }
}

#[test]
fn timeout_kills_git_descendants_that_keep_output_pipes_open() {
    let started = Instant::now();
    let output = GitRunner::new(Duration::from_millis(40))
        .run(
            None,
            [
                "-c",
                "alias.agentport-timeout=!printf before-timeout; sleep 3",
                "agentport-timeout",
            ],
        )
        .unwrap();
    let elapsed = started.elapsed();
    assert!(output.timed_out);
    assert!(output.stdout_lossy().contains("before-timeout"));
    assert!(
        elapsed < Duration::from_secs(1),
        "timeout returned after {elapsed:?}; a descendant likely retained Git's output pipe"
    );
}
