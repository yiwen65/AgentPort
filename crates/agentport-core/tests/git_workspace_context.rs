mod support;

use agentport_core::db::Db;
use agentport_core::git::{GitContextLocator, GitWorkspaceManager};
use agentport_core::models::{
    AgentTransport, AgentType, Lifecycle, PermissionMode, Preset, Project, ResumePrecision,
    Session, Worktree, WorktreeHealth,
};
use agentport_core::paths::AppPaths;
use agentport_core::CoreError;
use chrono::Utc;
use support::mock_repo::MockRepo;

#[test]
fn exact_context_distinguishes_main_and_registered_worktree() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let worktree_path = fixture.add_worktree(&db, "project-a", "wt-a", "feature/a");
    let manager = GitWorkspaceManager::new(&db);

    let main = manager
        .resolve(&GitContextLocator::ProjectMain {
            project_id: "project-a".into(),
        })
        .unwrap();
    let worktree = manager
        .resolve(&GitContextLocator::Worktree {
            project_id: "project-a".into(),
            worktree_id: "wt-a".into(),
        })
        .unwrap();

    assert_ne!(main.checkout_id, worktree.checkout_id);
    assert_eq!(main.checkout_root, fixture.root().to_string_lossy());
    assert_eq!(worktree.checkout_root, worktree_path.to_string_lossy());
    assert_eq!(worktree.actual_branch.as_deref(), Some("feature/a"));
    assert!(main.writable);
    assert!(worktree.writable);
}

#[test]
fn worktree_context_rejects_cross_project_association() {
    let fixture = MockRepo::new();
    let other = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.add_worktree(&db, "project-a", "wt-a", "feature/a");
    db.add_project(&Project {
        id: "project-b".into(),
        name: "project-b".into(),
        root_path: other.root().to_string_lossy().into_owned(),
        git_root_path: Some(other.root().to_string_lossy().into_owned()),
        created_at: Utc::now(),
    })
    .unwrap();

    let error = GitWorkspaceManager::new(&db)
        .resolve(&GitContextLocator::Worktree {
            project_id: "project-b".into(),
            worktree_id: "wt-a".into(),
        })
        .unwrap_err();
    assert!(matches!(error, CoreError::Conflict(_)));
    assert!(error.to_string().contains("belongs to project project-a"));
}

#[test]
fn missing_prunable_worktree_resolves_read_only_instead_of_falling_back_to_main() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let worktree = fixture.add_worktree(&db, "project-a", "wt-a", "feature/a");
    let moved = fixture.workspace().join("moved-worktree-data");
    std::fs::rename(&worktree, &moved).unwrap();

    let context = GitWorkspaceManager::new(&db)
        .resolve(&GitContextLocator::Worktree {
            project_id: "project-a".into(),
            worktree_id: "wt-a".into(),
        })
        .unwrap();

    assert_eq!(context.checkout_root, worktree.to_string_lossy());
    assert!(!context.writable);
    assert!(context
        .blockers
        .iter()
        .any(|value| value == "worktree_missing"));
    assert!(context
        .blockers
        .iter()
        .any(|value| value == "worktree_prunable"));
    assert_ne!(
        context.checkout_id,
        GitWorkspaceManager::new(&db)
            .resolve(&GitContextLocator::ProjectMain {
                project_id: "project-a".into(),
            })
            .unwrap()
            .checkout_id
    );
}

#[test]
fn persisted_external_linked_worktree_is_read_only_at_the_production_boundary() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    fixture.add_worktree(&db, "project-a", "wt-a", "feature/a");
    let paths = AppPaths::new(fixture.workspace().join("agentport-data"));
    paths.ensure_layout().unwrap();

    let context = GitWorkspaceManager::new_with_paths(&db, &paths)
        .resolve(&GitContextLocator::Worktree {
            project_id: "project-a".into(),
            worktree_id: "wt-a".into(),
        })
        .unwrap();

    assert!(!context.writable);
    assert!(context
        .blockers
        .iter()
        .any(|value| value == "external_linked_worktree"));
}

#[test]
fn adopts_the_registered_branch_only_for_an_exact_branch_drift() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let worktree = fixture.add_worktree(&db, "project-a", "wt-a", "agent/original");
    fixture.git(&worktree, &["switch", "-c", "fix/current"]);
    let locator = GitContextLocator::Worktree {
        project_id: "project-a".into(),
        worktree_id: "wt-a".into(),
    };
    let manager = GitWorkspaceManager::new(&db);
    let drifted = manager.resolve(&locator).unwrap();

    assert!(!drifted.writable);
    assert_eq!(drifted.expected_branch.as_deref(), Some("agent/original"));
    assert_eq!(drifted.actual_branch.as_deref(), Some("fix/current"));
    assert_eq!(drifted.blockers, vec!["worktree_branch_drift"]);

    let adopted = manager
        .adopt_current_worktree_branch(
            &locator,
            &drifted.checkout_id,
            "agent/original",
            "fix/current",
        )
        .unwrap();

    assert!(adopted.writable);
    assert_eq!(adopted.expected_branch.as_deref(), Some("fix/current"));
    assert_eq!(adopted.actual_branch.as_deref(), Some("fix/current"));
    assert!(adopted.blockers.is_empty());
    assert_eq!(db.get_worktree("wt-a").unwrap().branch, "fix/current");
}

#[test]
fn worktree_path_and_common_directory_drift_are_rejected() {
    let fixture = MockRepo::new();
    let unrelated = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");

    db.insert_worktree(&Worktree {
        id: "wt-unrelated".into(),
        project_id: "project-a".into(),
        branch: "main".into(),
        base_commit: unrelated
            .git(unrelated.root(), &["rev-parse", "HEAD"])
            .trim()
            .into(),
        base_ref: None,
        path: unrelated.root().to_string_lossy().into_owned(),
        health: WorktreeHealth::Clean,
        created_at: Utc::now(),
    })
    .unwrap();
    let error = GitWorkspaceManager::new(&db)
        .resolve(&GitContextLocator::Worktree {
            project_id: "project-a".into(),
            worktree_id: "wt-unrelated".into(),
        })
        .unwrap_err();
    assert!(matches!(error, CoreError::Conflict(_)));
    assert!(error.to_string().contains("no longer belongs"));

    let nested = fixture.root().join("nested");
    std::fs::create_dir(&nested).unwrap();
    db.insert_worktree(&Worktree {
        id: "wt-path-drift".into(),
        project_id: "project-a".into(),
        branch: "main".into(),
        base_commit: fixture
            .git(fixture.root(), &["rev-parse", "HEAD"])
            .trim()
            .into(),
        base_ref: None,
        path: nested.to_string_lossy().into_owned(),
        health: WorktreeHealth::Clean,
        created_at: Utc::now(),
    })
    .unwrap();
    let error = GitWorkspaceManager::new(&db)
        .resolve(&GitContextLocator::Worktree {
            project_id: "project-a".into(),
            worktree_id: "wt-path-drift".into(),
        })
        .unwrap_err();
    assert!(matches!(error, CoreError::Conflict(_)));
    assert!(error.to_string().contains("different checkout"));
}

#[test]
fn session_locator_resolves_its_exact_worktree_and_only_live_sessions_warn() {
    let fixture = MockRepo::new();
    let db = Db::open_memory().unwrap();
    fixture.add_project(&db, "project-a");
    let worktree = fixture.add_worktree(&db, "project-a", "wt-a", "feature/session");
    let preset_id = "preset-session-test".to_owned();
    db.upsert_preset(&Preset {
        id: preset_id.clone(),
        agent_type: AgentType::Shell,
        name: "Session Test".into(),
        executable_path: "/bin/sh".into(),
        args: Vec::new(),
        permission_mode: PermissionMode::Native,
        env_names: Vec::new(),
        secret_ref_ids: Vec::new(),
        built_in: false,
    })
    .unwrap();
    let session = |id: &str, lifecycle: Lifecycle, cwd: String| Session {
        id: id.into(),
        project_id: "project-a".into(),
        worktree_id: Some("wt-a".into()),
        preset_id: preset_id.clone(),
        title: id.into(),
        cwd,
        host_pid: None,
        host_socket: None,
        host_token: format!("token-{id}"),
        lifecycle,
        agent_session_id: None,
        resume_precision: ResumePrecision::Unavailable,
        log_path: fixture
            .workspace()
            .join(format!("{id}.log"))
            .to_string_lossy()
            .into_owned(),
        adapter_type: AgentType::Shell,
        transport: AgentTransport::Pty,
        command: Vec::new(),
        permission_mode: PermissionMode::Native,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        archived_at: None,
    };
    db.insert_session(&session(
        "session-live",
        Lifecycle::Running,
        worktree.to_string_lossy().into_owned(),
    ))
    .unwrap();
    db.insert_session(&session(
        "session-stopped",
        Lifecycle::Stopped,
        worktree.to_string_lossy().into_owned(),
    ))
    .unwrap();

    let manager = GitWorkspaceManager::new(&db);
    let by_session = manager
        .resolve(&GitContextLocator::Session {
            session_id: "session-live".into(),
        })
        .unwrap();
    let by_worktree = manager
        .resolve(&GitContextLocator::Worktree {
            project_id: "project-a".into(),
            worktree_id: "wt-a".into(),
        })
        .unwrap();
    assert_eq!(by_session.checkout_id, by_worktree.checkout_id);
    assert_eq!(by_session.actual_branch.as_deref(), Some("feature/session"));
    assert_eq!(by_session.live_session_ids, vec!["session-live"]);

    db.insert_session(&session(
        "session-drift",
        Lifecycle::Running,
        fixture.root().to_string_lossy().into_owned(),
    ))
    .unwrap();
    let drift = manager
        .resolve(&GitContextLocator::Session {
            session_id: "session-drift".into(),
        })
        .unwrap_err();
    assert!(matches!(drift, CoreError::Conflict(_)), "{drift}");
}
