use agentport_core::db::Db;
use agentport_core::git::{
    is_unmerged_delete_block, BranchManager, BranchOperationKind, BranchOperationPhase,
    UNMERGED_DELETE_BLOCK_MARKER,
};
use agentport_core::models::Project;
use agentport_core::CoreError;
use chrono::Utc;
use rusqlite::params;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

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

fn git_succeeds(root: &Path, args: &[&str]) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let raw = temp.path().join("branch deletion repo ü");
    std::fs::create_dir(&raw).unwrap();
    git(&raw, &["init", "-b", "main"]);
    git(&raw, &["config", "user.name", "AgentPort Delete"]);
    git(
        &raw,
        &["config", "user.email", "agentport-delete@test.invalid"],
    );
    std::fs::write(raw.join("tracked.txt"), "base\n").unwrap();
    git(&raw, &["add", "--", "tracked.txt"]);
    git(
        &raw,
        &["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
    );
    let root = std::fs::canonicalize(raw).unwrap();
    let db = Db::open_memory().unwrap();
    let project_id = "branch_delete_project".to_owned();
    db.add_project(&Project {
        id: project_id.clone(),
        name: "Branch delete".into(),
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

fn branch_exists(manager: &BranchManager<'_>, project_id: &str, name: &str) -> bool {
    manager
        .list(project_id)
        .unwrap()
        .branches
        .iter()
        .any(|branch| branch.name == name)
}

fn insert_prepared_delete(fixture: &Fixture, operation_id: &str, branch: &str) -> String {
    let manager = BranchManager::new(&fixture.db);
    let snapshot = manager.list(&fixture.project_id).unwrap();
    let head = git(&fixture.root, &["rev-parse", "HEAD"]).trim().to_owned();
    let target_oid = git(
        &fixture.root,
        &["rev-parse", &format!("refs/heads/{branch}")],
    )
    .trim()
    .to_owned();
    let now = Utc::now().to_rfc3339();
    fixture
        .db
        .conn()
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO branch_operations(
                id,kind,project_id,repo_key,checkout_root,source_branch,source_commit,target_branch,
                target_oid,phase,stash_oid,stash_selector,stash_marker,snapshot_json,error_json,
                created_at,updated_at,completed_at
             ) VALUES(?1,'delete',?2,?3,?4,'main',?5,?6,?7,'prepared',NULL,NULL,NULL,NULL,NULL,?8,?8,NULL)",
            params![
                operation_id,
                fixture.project_id,
                snapshot.repo_key,
                snapshot.repository_root,
                head,
                branch,
                target_oid,
                now,
            ],
        )
        .unwrap();
    target_oid
}

#[test]
fn deletes_only_an_exact_merged_local_branch() {
    let fixture = fixture();
    git(&fixture.root, &["branch", "merged/feature"]);
    git(
        &fixture.root,
        &["branch", "--set-upstream-to=main", "merged/feature"],
    );
    let manager = BranchManager::new(&fixture.db);
    let expected_oid = git(&fixture.root, &["rev-parse", "refs/heads/merged/feature"])
        .trim()
        .to_owned();

    let deleted = manager
        .delete(&fixture.project_id, "merged/feature")
        .unwrap();

    assert_eq!(deleted.branch_name, "merged/feature");
    assert_eq!(deleted.deleted_oid, expected_oid);
    assert!(!branch_exists(
        &manager,
        &fixture.project_id,
        "merged/feature"
    ));
    let operation = manager.operation(&deleted.operation_id).unwrap();
    assert_eq!(operation.kind, BranchOperationKind::Delete);
    assert_eq!(operation.phase, BranchOperationPhase::Completed);
    // Keep the section: an external client may immediately recreate the same
    // branch name, and deleting config here would race with that new branch.
    assert!(git_succeeds(
        &fixture.root,
        &["config", "--get", "branch.merged/feature.remote"]
    ));
}

#[test]
fn dirty_worktree_is_unchanged_when_an_unoccupied_branch_is_deleted() {
    let fixture = fixture();
    git(&fixture.root, &["branch", "merged/dirty-safe"]);
    std::fs::write(fixture.root.join("tracked.txt"), "base\nunstaged\n").unwrap();
    std::fs::write(fixture.root.join("untracked.txt"), "keep me\n").unwrap();
    let before_status = git(&fixture.root, &["status", "--porcelain=v2"]);
    let before_tracked = std::fs::read(fixture.root.join("tracked.txt")).unwrap();
    let before_untracked = std::fs::read(fixture.root.join("untracked.txt")).unwrap();

    BranchManager::new(&fixture.db)
        .delete(&fixture.project_id, "merged/dirty-safe")
        .unwrap();

    assert_eq!(
        git(&fixture.root, &["status", "--porcelain=v2"]),
        before_status
    );
    assert_eq!(
        std::fs::read(fixture.root.join("tracked.txt")).unwrap(),
        before_tracked
    );
    assert_eq!(
        std::fs::read(fixture.root.join("untracked.txt")).unwrap(),
        before_untracked
    );
}

#[test]
fn rejects_current_and_linked_worktree_branches() {
    let fixture = fixture();
    let manager = BranchManager::new(&fixture.db);
    let current_error = manager.delete(&fixture.project_id, "main").unwrap_err();
    assert!(matches!(current_error, CoreError::Blocked(_)));
    assert!(branch_exists(&manager, &fixture.project_id, "main"));

    git(&fixture.root, &["branch", "occupied/feature"]);
    let linked = fixture._temp.path().join("linked checkout ü");
    git(
        &fixture.root,
        &[
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "occupied/feature",
        ],
    );
    let occupied_error = manager
        .delete(&fixture.project_id, "occupied/feature")
        .unwrap_err();
    assert!(matches!(occupied_error, CoreError::Blocked(_)));
    assert!(occupied_error.to_string().contains("worktree"));
    assert!(branch_exists(
        &manager,
        &fixture.project_id,
        "occupied/feature"
    ));
}

#[test]
fn git_merged_only_rule_rejects_unmerged_branch_without_losing_ref() {
    let fixture = fixture();
    git(&fixture.root, &["switch", "-c", "unmerged/feature"]);
    std::fs::write(fixture.root.join("feature.txt"), "not merged\n").unwrap();
    git(&fixture.root, &["add", "--", "feature.txt"]);
    git(
        &fixture.root,
        &[
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "unmerged feature",
        ],
    );
    let feature_oid = git(&fixture.root, &["rev-parse", "HEAD"]).trim().to_owned();
    git(&fixture.root, &["switch", "main"]);
    let manager = BranchManager::new(&fixture.db);

    let error = manager
        .delete(&fixture.project_id, "unmerged/feature")
        .unwrap_err();
    assert!(matches!(error, CoreError::Blocked(_)), "{error}");
    // The command layer relies on this exact signal to offer a force retry.
    assert!(is_unmerged_delete_block(&error), "{error}");
    assert_eq!(
        git(&fixture.root, &["rev-parse", "refs/heads/unmerged/feature"]).trim(),
        feature_oid
    );
}

#[test]
fn force_delete_removes_an_unmerged_branch() {
    let fixture = fixture();
    git(&fixture.root, &["switch", "-c", "abandoned/backup"]);
    std::fs::write(fixture.root.join("backup.txt"), "abandoned work\n").unwrap();
    git(&fixture.root, &["add", "--", "backup.txt"]);
    git(
        &fixture.root,
        &["-c", "commit.gpgsign=false", "commit", "-m", "abandoned work"],
    );
    let backup_oid = git(&fixture.root, &["rev-parse", "HEAD"]).trim().to_owned();
    git(&fixture.root, &["switch", "main"]);
    let manager = BranchManager::new(&fixture.db);

    let deleted = manager
        .delete_forced(&fixture.project_id, "abandoned/backup")
        .unwrap();

    assert_eq!(deleted.branch_name, "abandoned/backup");
    assert_eq!(deleted.deleted_oid, backup_oid);
    assert!(!branch_exists(
        &manager,
        &fixture.project_id,
        "abandoned/backup"
    ));
    let operation = manager.operation(&deleted.operation_id).unwrap();
    assert_eq!(operation.kind, BranchOperationKind::Delete);
    assert_eq!(operation.phase, BranchOperationPhase::Completed);
}

#[test]
fn force_delete_keeps_checkout_worktree_and_input_guards() {
    let fixture = fixture();
    let manager = BranchManager::new(&fixture.db);

    let current_error = manager.delete_forced(&fixture.project_id, "main").unwrap_err();
    assert!(matches!(current_error, CoreError::Blocked(_)));
    assert!(branch_exists(&manager, &fixture.project_id, "main"));

    git(&fixture.root, &["branch", "occupied/force"]);
    let linked = fixture._temp.path().join("force linked checkout ü");
    git(
        &fixture.root,
        &[
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "occupied/force",
        ],
    );
    let occupied_error = manager
        .delete_forced(&fixture.project_id, "occupied/force")
        .unwrap_err();
    assert!(matches!(occupied_error, CoreError::Blocked(_)));
    assert!(branch_exists(&manager, &fixture.project_id, "occupied/force"));

    for malicious in ["--force", "safe;touch injected", " safe"] {
        let error = manager
            .delete_forced(&fixture.project_id, malicious)
            .unwrap_err();
        assert!(matches!(error, CoreError::Validation(_)), "{error}");
    }
    assert!(!fixture.root.join("injected").exists());
}

#[test]
fn unmerged_delete_block_marker_matches_only_the_merged_gate() {
    // Other blocked delete failures must not be misread as force-deletable.
    let occupied = CoreError::Blocked(
        "cannot delete branch occupied/feature; it is checked out in worktree /tmp/x".to_owned(),
    );
    assert!(!is_unmerged_delete_block(&occupied));
    let unmerged = CoreError::Blocked(format!(
        "cannot delete branch backup/old; commit abc123 {UNMERGED_DELETE_BLOCK_MARKER} def456"
    ));
    assert!(is_unmerged_delete_block(&unmerged));
    let conflict = CoreError::Conflict(format!("commit abc123 {UNMERGED_DELETE_BLOCK_MARKER}"));
    assert!(!is_unmerged_delete_block(&conflict));
}


#[test]
fn rejects_option_like_and_invalid_branch_input_as_argv_data() {
    let fixture = fixture();
    git(&fixture.root, &["branch", "safe"]);
    let manager = BranchManager::new(&fixture.db);

    for malicious in ["--force", "safe;touch injected", " safe"] {
        let error = manager.delete(&fixture.project_id, malicious).unwrap_err();
        assert!(matches!(error, CoreError::Validation(_)), "{error}");
    }
    assert!(branch_exists(&manager, &fixture.project_id, "safe"));
    assert!(!fixture.root.join("injected").exists());
}

#[test]
fn unfinished_branch_operation_protects_its_source_and_target_refs() {
    let fixture = fixture();
    git(&fixture.root, &["branch", "protected/source"]);
    git(&fixture.root, &["branch", "protected/target"]);
    let manager = BranchManager::new(&fixture.db);
    let snapshot = manager.list(&fixture.project_id).unwrap();
    let head = git(&fixture.root, &["rev-parse", "HEAD"]).trim().to_owned();
    let now = Utc::now().to_rfc3339();
    fixture
        .db
        .conn()
        .lock()
        .unwrap()
        .execute(
            "INSERT INTO branch_operations(
                id,kind,project_id,repo_key,checkout_root,source_branch,source_commit,target_branch,
                target_oid,phase,stash_oid,stash_selector,stash_marker,snapshot_json,error_json,
                created_at,updated_at,completed_at
             ) VALUES(?1,'switch',?2,?3,?4,?5,?6,?7,?8,'switched',NULL,NULL,NULL,NULL,NULL,?9,?9,NULL)",
            params![
                "op_protect_refs",
                fixture.project_id,
                snapshot.repo_key,
                snapshot.repository_root,
                "protected/source",
                head,
                "protected/target",
                git(&fixture.root, &["rev-parse", "refs/heads/protected/target"])
                    .trim(),
                now,
            ],
        )
        .unwrap();

    for branch in ["protected/source", "protected/target"] {
        let error = manager.delete(&fixture.project_id, branch).unwrap_err();
        assert!(matches!(error, CoreError::Blocked(_)), "{error}");
        assert!(error.to_string().contains("op_protect_refs"));
        assert!(branch_exists(&manager, &fixture.project_id, branch));
    }
}

#[test]
fn startup_reconcile_completes_an_absent_ref_despite_unrelated_status_drift() {
    let fixture = fixture();
    git(&fixture.root, &["branch", "restart/deleted"]);
    let target_oid = insert_prepared_delete(&fixture, "op_restart_deleted", "restart/deleted");
    git(
        &fixture.root,
        &[
            "update-ref",
            "-d",
            "refs/heads/restart/deleted",
            &target_oid,
        ],
    );
    std::fs::write(fixture.root.join("tracked.txt"), "unrelated drift\n").unwrap();
    std::fs::write(fixture.root.join("untracked-drift.txt"), "keep\n").unwrap();

    let manager = BranchManager::new(&fixture.db);
    manager.reconcile(&fixture.project_id).unwrap();

    assert_eq!(
        manager.operation("op_restart_deleted").unwrap().phase,
        BranchOperationPhase::Completed
    );
    assert!(!branch_exists(
        &manager,
        &fixture.project_id,
        "restart/deleted"
    ));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("tracked.txt")).unwrap(),
        "unrelated drift\n"
    );
}

#[test]
fn startup_reconcile_restores_absent_ref_required_by_a_worktree() {
    let fixture = fixture();
    git(&fixture.root, &["branch", "restart/occupied"]);
    let linked = fixture._temp.path().join("restart occupied worktree");
    git(
        &fixture.root,
        &[
            "worktree",
            "add",
            linked.to_str().unwrap(),
            "restart/occupied",
        ],
    );
    let target_oid = insert_prepared_delete(&fixture, "op_restart_occupied", "restart/occupied");
    git(
        &fixture.root,
        &[
            "update-ref",
            "-d",
            "refs/heads/restart/occupied",
            &target_oid,
        ],
    );

    let manager = BranchManager::new(&fixture.db);
    manager.reconcile(&fixture.project_id).unwrap();

    assert_eq!(
        manager.operation("op_restart_occupied").unwrap().phase,
        BranchOperationPhase::Failed
    );
    assert_eq!(
        git(&fixture.root, &["rev-parse", "refs/heads/restart/occupied"]).trim(),
        target_oid
    );
}
