use agentport_core::db::Db;
use agentport_core::git::{BranchManager, BranchOperationPhase, CheckoutState, RestoreStrategy};
use agentport_core::models::Project;
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::{Command, Stdio};

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

fn sha256(path: &Path) -> String {
    format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
}

#[test]
fn public_api_dirty_switch_restore_and_exact_cleanup_preserve_hashes_and_index() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("branch safety ü");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-b", "main"]);
    git(&root, &["config", "user.name", "AgentPort Integration"]);
    git(
        &root,
        &["config", "user.email", "agentport-integration@test.invalid"],
    );
    std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
    std::fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
    git(&root, &["add", "tracked.txt", ".gitignore"]);
    git(
        &root,
        &["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
    );
    git(&root, &["branch", "target"]);

    std::fs::write(root.join("tracked.txt"), "staged value\n").unwrap();
    git(&root, &["add", "tracked.txt"]);
    std::fs::write(root.join("tracked.txt"), "working value\n").unwrap();
    std::fs::write(root.join("untracked ü.txt"), "untracked value\n").unwrap();
    std::fs::create_dir(root.join("ignored")).unwrap();
    std::fs::write(root.join("ignored/keep.bin"), b"ignored bytes\0\xff").unwrap();

    let working_hash = sha256(&root.join("tracked.txt"));
    let untracked_hash = sha256(&root.join("untracked ü.txt"));
    let ignored_hash = sha256(&root.join("ignored/keep.bin"));
    let staged_blob = git(&root, &["rev-parse", ":tracked.txt"]).trim().to_owned();

    let db = Db::open_memory().unwrap();
    db.add_project(&Project {
        id: "integration_project".into(),
        name: "Integration".into(),
        root_path: root.to_string_lossy().into_owned(),
        git_root_path: Some(root.to_string_lossy().into_owned()),
        created_at: Utc::now(),
    })
    .unwrap();
    let manager = BranchManager::new(&db);

    let switched = manager.switch("integration_project", "target").unwrap();
    assert!(switched.stashed && switched.pending_restore && !switched.restored);
    assert!(matches!(
        manager.list("integration_project").unwrap().status.checkout,
        CheckoutState::Branch(ref branch) if branch == "target"
    ));
    assert!(!root.join("untracked ü.txt").exists());
    assert_eq!(sha256(&root.join("ignored/keep.bin")), ignored_hash);
    let operation = manager.operation(&switched.operation_id).unwrap();
    assert_eq!(operation.phase, BranchOperationPhase::Switched);
    let stash_oid = git(&root, &["rev-parse", "refs/stash"]).trim().to_owned();
    assert_eq!(operation.stash_oid.as_deref(), Some(stash_oid.as_str()));

    let restored = manager
        .recover(&switched.operation_id, RestoreStrategy::Target)
        .unwrap();
    assert_eq!(restored.phase, BranchOperationPhase::RestoredVerified);
    assert_eq!(sha256(&root.join("tracked.txt")), working_hash);
    assert_eq!(sha256(&root.join("untracked ü.txt")), untracked_hash);
    assert_eq!(sha256(&root.join("ignored/keep.bin")), ignored_hash);
    assert_eq!(
        git(&root, &["rev-parse", ":tracked.txt"]).trim(),
        staged_blob
    );
    assert_eq!(
        git(&root, &["diff", "--cached", "--name-only"]).trim(),
        "tracked.txt"
    );
    assert_eq!(git(&root, &["diff", "--name-only"]).trim(), "tracked.txt");
    assert_eq!(git(&root, &["rev-parse", "refs/stash"]).trim(), stash_oid);

    let completed = manager.cleanup(&switched.operation_id).unwrap();
    assert_eq!(completed.phase, BranchOperationPhase::Completed);
    let stash_check = Command::new("git")
        .arg("-C")
        .arg(&root)
        .args(["rev-parse", "--verify", "refs/stash"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!stash_check.status.success());

    eprintln!(
        "branch-safety-evidence operation={} stash_oid={} worktree_sha256={} untracked_sha256={} ignored_sha256={} staged_blob={}",
        switched.operation_id,
        stash_oid,
        working_hash,
        untracked_hash,
        ignored_hash,
        staged_blob
    );
}
