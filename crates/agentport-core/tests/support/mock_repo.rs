#![allow(dead_code)]

use agentport_core::db::Db;
use agentport_core::models::{Project, Worktree, WorktreeHealth};
use chrono::Utc;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::Mutex;

const MARKER: &str = ".agentport-git-feature-mock";

pub struct MockRepo {
    _temp: tempfile::TempDir,
    workspace: PathBuf,
    repo: PathBuf,
    recorded_write_targets: Mutex<Vec<(String, PathBuf)>>,
}

impl MockRepo {
    pub fn new() -> Self {
        Self::create(true)
    }

    pub fn new_unborn() -> Self {
        Self::create(false)
    }

    fn create(with_initial_commit: bool) -> Self {
        let temp = tempfile::tempdir().expect("create isolated mock root");
        let workspace = temp.path().join("agentport-git-feature-mock");
        std::fs::create_dir(&workspace).expect("create mock workspace");
        std::fs::write(workspace.join(MARKER), b"AgentPort Git Center test only\n")
            .expect("write mock marker");
        let repo = workspace.join("main");
        std::fs::create_dir(&repo).expect("create mock repository");
        let repo = std::fs::canonicalize(repo).expect("canonical mock repository");

        let fixture = Self {
            _temp: temp,
            workspace,
            repo,
            recorded_write_targets: Mutex::new(Vec::new()),
        };
        fixture.git(&fixture.repo, &["init", "-b", "main"]);
        fixture.git(
            &fixture.repo,
            &["config", "user.name", "AgentPort Git Center Test"],
        );
        fixture.git(
            &fixture.repo,
            &["config", "user.email", "agentport-git-center@test.invalid"],
        );
        if with_initial_commit {
            std::fs::write(fixture.repo.join("tracked.txt"), "base\n").expect("write fixture file");
            fixture.git(&fixture.repo, &["add", "--", "tracked.txt"]);
            fixture.git(
                &fixture.repo,
                &["-c", "commit.gpgsign=false", "commit", "-m", "initial"],
            );
        }
        fixture
    }

    pub fn root(&self) -> &Path {
        &self.repo
    }

    pub fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub fn write(&self, relative: &str, contents: impl AsRef<[u8]>) {
        let target = self.repo.join(relative);
        assert!(
            target.starts_with(&self.repo),
            "mock write escaped repository: {}",
            target.display()
        );
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("create fixture parent");
        }
        std::fs::write(target, contents).expect("write fixture file");
    }

    pub fn git(&self, cwd: &Path, args: &[&str]) -> String {
        let output = self.git_output(cwd, args);
        assert!(
            output.status.success(),
            "git target={} args={args:?}: {}",
            cwd.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    pub fn git_output(&self, cwd: &Path, args: &[&str]) -> Output {
        self.assert_mock_target(cwd);
        Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .stdin(Stdio::null())
            .output()
            .expect("execute fixture git")
    }

    pub fn record_write_target(&self, operation: &str, target: &Path) {
        self.assert_mock_target(target);
        let canonical = std::fs::canonicalize(target).expect("canonical backend write target");
        self.recorded_write_targets
            .lock()
            .unwrap()
            .push((operation.to_owned(), canonical));
    }

    pub fn assert_recorded_write_targets_are_isolated(&self) {
        let workspace = std::fs::canonicalize(&self.workspace).expect("canonical mock workspace");
        let recorded = self.recorded_write_targets.lock().unwrap();
        assert!(
            !recorded.is_empty(),
            "test did not record any backend Git write target"
        );
        for (operation, target) in recorded.iter() {
            assert!(
                target.starts_with(&workspace),
                "{operation} escaped mock workspace: {}",
                target.display()
            );
        }
    }

    pub fn add_project(&self, db: &Db, id: &str) {
        db.add_project(&Project {
            id: id.into(),
            name: id.into(),
            root_path: self.repo.to_string_lossy().into_owned(),
            git_root_path: Some(self.repo.to_string_lossy().into_owned()),
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .expect("register mock project");
    }

    pub fn add_worktree(&self, db: &Db, project_id: &str, id: &str, branch: &str) -> PathBuf {
        let path = self.workspace.join(id);
        self.git(&self.repo, &["branch", branch]);
        self.git(
            &self.repo,
            &[
                "worktree",
                "add",
                path.to_str().expect("utf8 test path"),
                branch,
            ],
        );
        let canonical = std::fs::canonicalize(&path).expect("canonical mock worktree");
        let head = self.git(&canonical, &["rev-parse", "HEAD"]);
        db.insert_worktree(&Worktree {
            id: id.into(),
            project_id: project_id.into(),
            branch: branch.into(),
            base_commit: head.trim().into(),
            base_ref: None,
            path: canonical.to_string_lossy().into_owned(),
            health: WorktreeHealth::Clean,
            created_at: Utc::now(),
        })
        .expect("register mock worktree");
        canonical
    }

    fn assert_mock_target(&self, cwd: &Path) {
        let workspace = std::fs::canonicalize(&self.workspace).expect("canonical mock workspace");
        let target = std::fs::canonicalize(cwd).expect("canonical git target");
        assert!(
            workspace.join(MARKER).is_file(),
            "mock marker missing: {}",
            workspace.display()
        );
        assert!(
            target.starts_with(&workspace),
            "refusing Git command outside isolated mock: {}",
            target.display()
        );
    }
}
