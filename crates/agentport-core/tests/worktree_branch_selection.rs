use agentport_core::db::Db;
use agentport_core::git::{WorktreeBranchSelection, WorktreeManager};
use agentport_core::models::Project;
use agentport_core::paths::AppPaths;
use agentport_core::CoreError;
use chrono::Utc;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Fixture {
    _temp: tempfile::TempDir,
    repo: PathBuf,
    paths: AppPaths,
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
    let raw_repo = temp.path().join("repo with spaces ü");
    std::fs::create_dir_all(&raw_repo).unwrap();
    git(&raw_repo, &["init", "-b", "main"]);
    git(&raw_repo, &["config", "user.name", "AgentPort Worktree"]);
    git(
        &raw_repo,
        &["config", "user.email", "agentport-worktree@test.invalid"],
    );
    std::fs::write(raw_repo.join("tracked.txt"), "base\n").unwrap();
    git(&raw_repo, &["add", "--", "tracked.txt"]);
    git(
        &raw_repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
    );
    let repo = std::fs::canonicalize(raw_repo).unwrap();
    let paths = AppPaths::new(temp.path().join("AgentPort data ü"));
    paths.ensure_layout().unwrap();
    let db = Db::open_memory().unwrap();
    let project_id = "project_worktree_branch".to_owned();
    db.add_project(&Project {
        id: project_id.clone(),
        name: "Worktree Demo ü".into(),
        root_path: repo.to_string_lossy().into_owned(),
        git_root_path: Some(repo.to_string_lossy().into_owned()),
        created_at: Utc::now(),
        pinned: false,
        sort_order: 0,
    })
    .unwrap();
    Fixture {
        _temp: temp,
        repo,
        paths,
        db,
        project_id,
    }
}

#[test]
fn selected_unoccupied_local_branch_creates_worktree_at_the_expected_oid() {
    let fixture = fixture();
    let branch = "feature/本地修复";
    git(&fixture.repo, &["branch", branch]);
    let expected_oid = git(
        &fixture.repo,
        &["rev-parse", &format!("refs/heads/{branch}")],
    )
    .trim()
    .to_owned();
    let manager = WorktreeManager {
        paths: &fixture.paths,
        db: &fixture.db,
    };

    let created = manager
        .create_selected(
            &fixture.project_id,
            "使用已有本地分支",
            None,
            WorktreeBranchSelection::Existing {
                name: branch.to_owned(),
                expected_oid: expected_oid.clone(),
            },
        )
        .unwrap();

    assert_eq!(created.branch, branch);
    assert_eq!(created.base_commit, expected_oid);
    assert_eq!(
        git(Path::new(&created.path), &["rev-parse", "HEAD"]).trim(),
        expected_oid
    );
    assert_eq!(
        git(
            Path::new(&created.path),
            &["symbolic-ref", "--short", "HEAD"]
        )
        .trim(),
        branch
    );
    assert!(created.path.contains("worktree-demo"));
    assert!(!git_succeeds(
        &fixture.repo,
        &["config", "--get", &format!("branch.{branch}.remote")]
    ));
}

#[test]
fn current_and_other_worktree_checked_out_branches_are_blocked_with_paths() {
    let fixture = fixture();
    let manager = WorktreeManager {
        paths: &fixture.paths,
        db: &fixture.db,
    };
    let main_oid = git(&fixture.repo, &["rev-parse", "refs/heads/main"])
        .trim()
        .to_owned();

    let current_error = manager
        .create_selected(
            &fixture.project_id,
            "current branch",
            None,
            WorktreeBranchSelection::Existing {
                name: "main".into(),
                expected_oid: main_oid,
            },
        )
        .unwrap_err();
    assert!(
        matches!(current_error, CoreError::Blocked(_)),
        "{current_error}"
    );
    assert!(current_error
        .to_string()
        .contains(&fixture.repo.to_string_lossy().to_string()));

    git(&fixture.repo, &["branch", "feature/occupied"]);
    let occupied_oid = git(&fixture.repo, &["rev-parse", "refs/heads/feature/occupied"])
        .trim()
        .to_owned();
    let occupied_path = fixture._temp.path().join("other Worktree ü");
    git(
        &fixture.repo,
        &[
            "worktree",
            "add",
            occupied_path.to_str().unwrap(),
            "feature/occupied",
        ],
    );

    let occupied_error = manager
        .create_selected(
            &fixture.project_id,
            "occupied branch",
            None,
            WorktreeBranchSelection::Existing {
                name: "feature/occupied".into(),
                expected_oid: occupied_oid,
            },
        )
        .unwrap_err();
    assert!(
        matches!(occupied_error, CoreError::Blocked(_)),
        "{occupied_error}"
    );
    assert!(occupied_error
        .to_string()
        .contains(&occupied_path.to_string_lossy().to_string()));
}

#[test]
fn manual_new_and_auto_modes_keep_base_ref_and_generation_behavior() {
    let fixture = fixture();
    let manager = WorktreeManager {
        paths: &fixture.paths,
        db: &fixture.db,
    };
    let old_head = git(&fixture.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    std::fs::write(fixture.repo.join("second.txt"), "second\n").unwrap();
    git(&fixture.repo, &["add", "--", "second.txt"]);
    git(
        &fixture.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "second"],
    );

    let manual = manager
        .create_selected(
            &fixture.project_id,
            "manual branch task",
            Some("HEAD~1"),
            WorktreeBranchSelection::New {
                name: "feature/手动新建".into(),
            },
        )
        .unwrap();
    assert_eq!(manual.branch, "feature/手动新建");
    assert_eq!(manual.base_commit, old_head);
    assert_eq!(manual.base_ref.as_deref(), Some("HEAD~1"));

    let automatic = manager
        .create_selected(
            &fixture.project_id,
            "Auto Generated Branch",
            None,
            WorktreeBranchSelection::Auto,
        )
        .unwrap();
    assert_eq!(automatic.branch, "agent/auto-generated-branch");
    assert!(!git_succeeds(
        &fixture.repo,
        &[
            "config",
            "--get",
            "branch.agent/auto-generated-branch.remote"
        ]
    ));
}

#[test]
fn stale_selected_branch_delete_move_and_occupancy_stop_before_creation() {
    let fixture = fixture();
    let manager = WorktreeManager {
        paths: &fixture.paths,
        db: &fixture.db,
    };
    let main_oid = git(&fixture.repo, &["rev-parse", "HEAD"]).trim().to_owned();

    git(&fixture.repo, &["branch", "feature/deleted"]);
    git(&fixture.repo, &["branch", "-d", "feature/deleted"]);
    let deleted_error = manager
        .create_selected(
            &fixture.project_id,
            "deleted selection",
            None,
            WorktreeBranchSelection::Existing {
                name: "feature/deleted".into(),
                expected_oid: main_oid.clone(),
            },
        )
        .unwrap_err();
    assert!(
        matches!(deleted_error, CoreError::NotFound(_)),
        "{deleted_error}"
    );

    git(&fixture.repo, &["branch", "feature/moved"]);
    git(&fixture.repo, &["switch", "-c", "move-source"]);
    std::fs::write(fixture.repo.join("moved.txt"), "moved\n").unwrap();
    git(&fixture.repo, &["add", "--", "moved.txt"]);
    git(
        &fixture.repo,
        &["-c", "commit.gpgsign=false", "commit", "-m", "move target"],
    );
    let moved_oid = git(&fixture.repo, &["rev-parse", "HEAD"]).trim().to_owned();
    git(&fixture.repo, &["switch", "main"]);
    git(
        &fixture.repo,
        &["update-ref", "refs/heads/feature/moved", &moved_oid],
    );
    let moved_error = manager
        .create_selected(
            &fixture.project_id,
            "moved selection",
            None,
            WorktreeBranchSelection::Existing {
                name: "feature/moved".into(),
                expected_oid: main_oid.clone(),
            },
        )
        .unwrap_err();
    assert!(
        matches!(moved_error, CoreError::Conflict(_)),
        "{moved_error}"
    );
    assert!(moved_error.to_string().contains(&moved_oid));

    git(&fixture.repo, &["branch", "feature/became-occupied"]);
    let occupied_path = fixture._temp.path().join("late occupied");
    git(
        &fixture.repo,
        &[
            "worktree",
            "add",
            occupied_path.to_str().unwrap(),
            "feature/became-occupied",
        ],
    );
    let occupied_error = manager
        .create_selected(
            &fixture.project_id,
            "occupied selection",
            None,
            WorktreeBranchSelection::Existing {
                name: "feature/became-occupied".into(),
                expected_oid: main_oid,
            },
        )
        .unwrap_err();
    assert!(
        matches!(occupied_error, CoreError::Blocked(_)),
        "{occupied_error}"
    );
    assert!(occupied_error
        .to_string()
        .contains(&occupied_path.to_string_lossy().to_string()));
}

#[test]
fn option_like_input_is_rejected_and_shell_like_branch_text_is_argv_safe() {
    let fixture = fixture();
    let manager = WorktreeManager {
        paths: &fixture.paths,
        db: &fixture.db,
    };

    let option_error = manager
        .create_selected(
            &fixture.project_id,
            "invalid option",
            None,
            WorktreeBranchSelection::New {
                name: "--ignore-other-worktrees".into(),
            },
        )
        .unwrap_err();
    assert!(
        matches!(option_error, CoreError::Validation(_)),
        "{option_error}"
    );

    let branch = "feature/x;touch${IFS}agentport-pwned";
    let created = manager
        .create_selected(
            &fixture.project_id,
            "argv safe ü",
            None,
            WorktreeBranchSelection::New {
                name: branch.into(),
            },
        )
        .unwrap();
    assert_eq!(created.branch, branch);
    assert!(!fixture.repo.join("agentport-pwned").exists());
}
