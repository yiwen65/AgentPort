// Command errors intentionally carry a complete, serializable recovery
// snapshot across the Tauri boundary; boxing would complicate command error
// conversion without reducing the payload sent to the renderer.
#![allow(clippy::result_large_err)]

use agentport_core::db::Db;
use agentport_core::error::CoreError;
use agentport_core::git::{
    AutoStash, BranchManager, BranchOperation, BranchOperationPhase, BranchSnapshot, CheckoutState,
    GitRunner, RepositoryIdentity, RestoreStrategy,
};
use agentport_core::models::Lifecycle;
use agentport_core::paths::AppPaths;
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::hash::{Hash, Hasher};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

type CommandResult<T> = std::result::Result<T, CommandError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: String,
    message: String,
    phase: String,
    operation_id: String,
    recoverable: bool,
    current_status: Option<RepositoryStatus>,
    recovery_actions: Vec<String>,
    recovery_action_codes: Vec<String>,
    diagnostics: Value,
    live_session_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryStatus {
    project_id: String,
    is_git_repository: bool,
    checkout_root: Option<String>,
    repo_key: Option<String>,
    head: RepositoryHead,
    changes: RepositoryChanges,
    ongoing_operation: Option<String>,
    live_session_ids: Vec<String>,
    pending_auto_stashes: usize,
    observed_at: String,
    snapshot_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryHead {
    kind: &'static str,
    branch: Option<String>,
    oid: Option<String>,
    short_oid: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryChanges {
    staged: usize,
    unstaged: usize,
    untracked: usize,
    unmerged: usize,
    dirty_submodules: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranch {
    name: String,
    oid: String,
    current: bool,
    checked_out_path: Option<String>,
    agent_port_worktree_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoStashRecord {
    id: String,
    operation_id: String,
    project_id: String,
    source_kind: &'static str,
    source_branch: Option<String>,
    source_oid: Option<String>,
    target_branch: String,
    stash_oid: Option<String>,
    marker: String,
    created_at: String,
    state: String,
    last_error: Option<String>,
    restorable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchesResponse {
    status: RepositoryStatus,
    branches: Vec<LocalBranch>,
    auto_stashes: Vec<AutoStashRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOperationResult {
    operation_id: String,
    status: RepositoryStatus,
    auto_stash: Option<AutoStashRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryOperationProgress {
    operation_id: String,
    command: &'static str,
    project_id: Option<String>,
    branch: Option<String>,
    phase: String,
    message: String,
    core_operation_id: Option<String>,
    recoverable: bool,
    occurred_at: String,
}

#[tauri::command]
pub async fn get_repository_status(
    state: State<'_, AppState>,
    _app: AppHandle,
    project_id: String,
) -> CommandResult<RepositoryStatus> {
    let operation_id = wrapper_operation_id("status");
    run_blocking(
        state.paths.clone(),
        Some(project_id.clone()),
        operation_id,
        "get_repository_status",
        "status",
        move |db, manager| repository_response(db, manager, &project_id).map(|value| value.status),
    )
    .await
}

#[tauri::command]
pub async fn list_local_branches(
    state: State<'_, AppState>,
    _app: AppHandle,
    project_id: String,
) -> CommandResult<LocalBranchesResponse> {
    let operation_id = wrapper_operation_id("list_branches");
    run_blocking(
        state.paths.clone(),
        Some(project_id.clone()),
        operation_id,
        "list_local_branches",
        "list",
        move |db, manager| repository_response(db, manager, &project_id),
    )
    .await
}

#[tauri::command]
pub async fn create_local_branch(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    name: String,
    start_point: Option<String>,
) -> CommandResult<BranchOperationResult> {
    let operation_id = wrapper_operation_id("create_branch");
    emit_progress(
        &app,
        RepositoryOperationProgress {
            operation_id: operation_id.clone(),
            command: "create_local_branch",
            project_id: Some(project_id.clone()),
            branch: Some(name.clone()),
            phase: "started".into(),
            message: "creating local branch".into(),
            core_operation_id: None,
            recoverable: false,
            occurred_at: now_string(),
        },
    );
    let error_branch = name.clone();
    let result = run_blocking(
        state.paths.clone(),
        Some(project_id.clone()),
        operation_id.clone(),
        "create_local_branch",
        "create",
        move |db, manager| {
            let created = manager.create(&project_id, &name, start_point.as_deref())?;
            let response = repository_response(db, manager, &project_id)?;
            Ok(BranchOperationResult {
                operation_id: created.operation_id,
                status: response.status,
                auto_stash: None,
            })
        },
    )
    .await;
    match result {
        Ok(result) => {
            emit_repository_state(&app, &result.status);
            let core_operation_id = result.operation_id.clone();
            emit_progress(
                &app,
                RepositoryOperationProgress {
                    operation_id,
                    command: "create_local_branch",
                    project_id: Some(result.status.project_id.clone()),
                    branch: Some(error_branch),
                    phase: "completed".into(),
                    message: "local branch created".into(),
                    core_operation_id: Some(core_operation_id),
                    recoverable: false,
                    occurred_at: now_string(),
                },
            );
            Ok(result)
        }
        Err(error) => {
            emit_error_progress(
                &app,
                "create_local_branch",
                &error,
                Some(error_branch),
                operation_id,
                None,
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn create_and_switch_local_branch(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    name: String,
    start_point: Option<String>,
) -> CommandResult<BranchOperationResult> {
    let operation_id = wrapper_operation_id("create_switch_branch");
    emit_progress(
        &app,
        RepositoryOperationProgress {
            operation_id: operation_id.clone(),
            command: "create_and_switch_local_branch",
            project_id: Some(project_id.clone()),
            branch: Some(name.clone()),
            phase: "started".into(),
            message: "creating and switching local branch".into(),
            core_operation_id: None,
            recoverable: false,
            occurred_at: now_string(),
        },
    );
    let error_branch = name.clone();
    let result = run_blocking(
        state.paths.clone(),
        Some(project_id.clone()),
        operation_id.clone(),
        "create_and_switch_local_branch",
        "create_and_switch",
        move |db, manager| {
            let outcome = manager.create_and_switch(&project_id, &name, start_point.as_deref())?;
            let operation = manager.operation(&outcome.operation_id)?;
            let restore_required = outcome.pending_restore
                || (outcome.stashed && matches!(operation.phase, BranchOperationPhase::Switched));
            let response = repository_response(db, manager, &project_id)?;
            let auto_stash = response
                .auto_stashes
                .iter()
                .find(|stash| stash.operation_id == outcome.operation_id)
                .cloned();
            Ok((
                BranchOperationResult {
                    operation_id: outcome.operation_id,
                    status: response.status,
                    auto_stash,
                },
                restore_required,
            ))
        },
    )
    .await;
    match result {
        Ok((result, restore_required)) => {
            emit_repository_state(&app, &result.status);
            emit_progress(
                &app,
                RepositoryOperationProgress {
                    operation_id,
                    command: "create_and_switch_local_branch",
                    project_id: Some(result.status.project_id.clone()),
                    branch: Some(error_branch),
                    phase: if restore_required {
                        "pending_restore".into()
                    } else {
                        "completed".into()
                    },
                    message: if restore_required {
                        "local branch created and switched; dirty state restore is required".into()
                    } else {
                        "local branch created and switched".into()
                    },
                    core_operation_id: Some(result.operation_id.clone()),
                    recoverable: restore_required,
                    occurred_at: now_string(),
                },
            );
            if let Some(stash) = &result.auto_stash {
                emit_auto_stash_changed(&app, stash);
            }
            Ok(result)
        }
        Err(error) => {
            emit_error_progress(
                &app,
                "create_and_switch_local_branch",
                &error,
                Some(error_branch),
                operation_id,
                None,
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn delete_local_branch(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    branch: String,
) -> CommandResult<BranchOperationResult> {
    let operation_id = wrapper_operation_id("delete_branch");
    emit_progress(
        &app,
        RepositoryOperationProgress {
            operation_id: operation_id.clone(),
            command: "delete_local_branch",
            project_id: Some(project_id.clone()),
            branch: Some(branch.clone()),
            phase: "started".into(),
            message: "deleting merged local branch".into(),
            core_operation_id: None,
            recoverable: false,
            occurred_at: now_string(),
        },
    );
    let event_branch = branch.clone();
    let result = run_blocking(
        state.paths.clone(),
        Some(project_id.clone()),
        operation_id.clone(),
        "delete_local_branch",
        "delete",
        move |db, manager| {
            let deleted = manager.delete(&project_id, &branch)?;
            let response = repository_response(db, manager, &project_id)?;
            Ok(BranchOperationResult {
                operation_id: deleted.operation_id,
                status: response.status,
                auto_stash: None,
            })
        },
    )
    .await;
    match result {
        Ok(result) => {
            emit_repository_state(&app, &result.status);
            emit_progress(
                &app,
                RepositoryOperationProgress {
                    operation_id,
                    command: "delete_local_branch",
                    project_id: Some(result.status.project_id.clone()),
                    branch: Some(event_branch),
                    phase: "completed".into(),
                    message: "local branch deleted".into(),
                    core_operation_id: Some(result.operation_id.clone()),
                    recoverable: false,
                    occurred_at: now_string(),
                },
            );
            Ok(result)
        }
        Err(error) => {
            emit_error_progress(
                &app,
                "delete_local_branch",
                &error,
                Some(event_branch),
                operation_id,
                None,
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn switch_local_branch(
    state: State<'_, AppState>,
    app: AppHandle,
    project_id: String,
    branch: String,
) -> CommandResult<BranchOperationResult> {
    let operation_id = wrapper_operation_id("switch_branch");
    emit_progress(
        &app,
        RepositoryOperationProgress {
            operation_id: operation_id.clone(),
            command: "switch_local_branch",
            project_id: Some(project_id.clone()),
            branch: Some(branch.clone()),
            phase: "started".into(),
            message: "switching local branch".into(),
            core_operation_id: None,
            recoverable: false,
            occurred_at: now_string(),
        },
    );
    let error_branch = branch.clone();
    let result = run_blocking(
        state.paths.clone(),
        Some(project_id.clone()),
        operation_id.clone(),
        "switch_local_branch",
        "switch",
        move |db, manager| {
            let outcome = manager.switch(&project_id, &branch)?;
            let operation = manager.operation(&outcome.operation_id)?;
            let restore_required = outcome.pending_restore
                || (outcome.stashed && matches!(operation.phase, BranchOperationPhase::Switched));
            let response = repository_response(db, manager, &project_id)?;
            let auto_stash = response
                .auto_stashes
                .iter()
                .find(|stash| stash.operation_id == outcome.operation_id)
                .cloned();
            Ok((
                BranchOperationResult {
                    operation_id: outcome.operation_id,
                    status: response.status,
                    auto_stash,
                },
                restore_required,
            ))
        },
    )
    .await;
    match result {
        Ok((result, restore_required)) => {
            emit_repository_state(&app, &result.status);
            emit_progress(
                &app,
                RepositoryOperationProgress {
                    operation_id,
                    command: "switch_local_branch",
                    project_id: Some(result.status.project_id.clone()),
                    branch: Some(error_branch),
                    phase: if restore_required {
                        "pending_restore".into()
                    } else {
                        "completed".into()
                    },
                    message: if restore_required {
                        "dirty state was auto-stashed; restore is required".into()
                    } else {
                        "local branch switched".into()
                    },
                    core_operation_id: Some(result.operation_id.clone()),
                    recoverable: restore_required,
                    occurred_at: now_string(),
                },
            );
            if let Some(stash) = &result.auto_stash {
                emit_auto_stash_changed(&app, stash);
            }
            Ok(result)
        }
        Err(error) => {
            emit_error_progress(
                &app,
                "switch_local_branch",
                &error,
                Some(error_branch),
                operation_id,
                None,
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn list_auto_stashes(
    state: State<'_, AppState>,
    _app: AppHandle,
    project_id: Option<String>,
) -> CommandResult<Vec<AutoStashRecord>> {
    let operation_id = wrapper_operation_id("list_stashes");
    run_blocking(
        state.paths.clone(),
        project_id.clone(),
        operation_id,
        "list_auto_stashes",
        "reconcile",
        move |db, manager| {
            let project_ids = match project_id {
                Some(project_id) => vec![project_id],
                None => db
                    .list_projects()?
                    .into_iter()
                    .map(|project| project.id)
                    .collect(),
            };
            let mut records = Vec::new();
            for project_id in project_ids {
                match manager.reconcile(&project_id) {
                    Ok(_) => {}
                    Err(CoreError::NotFound(_)) => continue,
                    Err(error) => return Err(error.into()),
                }
                records.extend(
                    manager
                        .list_auto_stashes(&project_id)?
                        .into_iter()
                        .map(|stash| auto_stash_record(manager, &project_id, stash)),
                );
            }
            Ok(records)
        },
    )
    .await
}

#[tauri::command]
pub async fn restore_auto_stash(
    state: State<'_, AppState>,
    app: AppHandle,
    operation_id: String,
    strategy: Option<String>,
) -> CommandResult<BranchOperationResult> {
    let wrapper_id = wrapper_operation_id("restore_stash");
    let error_operation_id = operation_id.clone();
    let progress_app = app.clone();
    let progress_wrapper_id = wrapper_id.clone();
    let result = run_operation_blocking(
        state.paths.clone(),
        operation_id,
        "restore_auto_stash",
        "restore",
        move |db, manager, prepared| {
            emit_progress(
                &progress_app,
                RepositoryOperationProgress {
                    operation_id: progress_wrapper_id,
                    command: "restore_auto_stash",
                    project_id: Some(prepared.project_id.clone()),
                    branch: None,
                    phase: "started".into(),
                    message: "restoring exact AgentPort auto-stash".into(),
                    core_operation_id: Some(prepared.id.clone()),
                    recoverable: false,
                    occurred_at: now_string(),
                },
            );
            let parsed_strategy = parse_restore_strategy(strategy).map_err(|error| {
                CommandError::from_core(
                    error,
                    Some(db),
                    Some(&prepared.project_id),
                    prepared.id.clone(),
                    "restore_auto_stash",
                    "restore",
                )
            })?;
            let operation = manager.recover(&prepared.id, parsed_strategy)?;
            let response = repository_response(db, manager, &operation.project_id)?;
            let auto_stash = response
                .auto_stashes
                .into_iter()
                .find(|stash| stash.operation_id == operation.id);
            Ok(BranchOperationResult {
                operation_id: operation.id,
                status: response.status,
                auto_stash,
            })
        },
    )
    .await;
    match result {
        Ok(result) => {
            emit_repository_state(&app, &result.status);
            if let Some(stash) = &result.auto_stash {
                emit_auto_stash_changed(&app, stash);
            }
            let phase = result
                .auto_stash
                .as_ref()
                .map(|stash| stash.state.clone())
                .unwrap_or_else(|| "completed".into());
            emit_progress(
                &app,
                RepositoryOperationProgress {
                    operation_id: wrapper_id,
                    command: "restore_auto_stash",
                    project_id: Some(result.status.project_id.clone()),
                    branch: None,
                    phase,
                    message: "auto-stash restore command finished".into(),
                    core_operation_id: Some(result.operation_id.clone()),
                    recoverable: result.auto_stash.is_some(),
                    occurred_at: now_string(),
                },
            );
            Ok(result)
        }
        Err(error) => {
            emit_error_progress(
                &app,
                "restore_auto_stash",
                &error,
                None,
                wrapper_id,
                Some(error_operation_id),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn cleanup_auto_stash(
    state: State<'_, AppState>,
    app: AppHandle,
    operation_id: String,
) -> CommandResult<BranchOperationResult> {
    let wrapper_id = wrapper_operation_id("cleanup_stash");
    let error_operation_id = operation_id.clone();
    let progress_app = app.clone();
    let progress_wrapper_id = wrapper_id.clone();
    let result = run_operation_blocking(
        state.paths.clone(),
        operation_id,
        "cleanup_auto_stash",
        "cleanup",
        move |db, manager, prepared| {
            emit_progress(
                &progress_app,
                RepositoryOperationProgress {
                    operation_id: progress_wrapper_id,
                    command: "cleanup_auto_stash",
                    project_id: Some(prepared.project_id.clone()),
                    branch: None,
                    phase: "started".into(),
                    message: "cleaning up exact AgentPort auto-stash".into(),
                    core_operation_id: Some(prepared.id.clone()),
                    recoverable: false,
                    occurred_at: now_string(),
                },
            );
            let operation = manager.cleanup(&prepared.id)?;
            let response = repository_response(db, manager, &operation.project_id)?;
            Ok(BranchOperationResult {
                operation_id: operation.id,
                status: response.status,
                auto_stash: None,
            })
        },
    )
    .await;
    match result {
        Ok(result) => {
            emit_repository_state(&app, &result.status);
            emit_progress(
                &app,
                RepositoryOperationProgress {
                    operation_id: wrapper_id,
                    command: "cleanup_auto_stash",
                    project_id: Some(result.status.project_id.clone()),
                    branch: None,
                    phase: "completed".into(),
                    message: "auto-stash cleanup command finished".into(),
                    core_operation_id: Some(result.operation_id.clone()),
                    recoverable: false,
                    occurred_at: now_string(),
                },
            );
            Ok(result)
        }
        Err(error) => {
            emit_error_progress(
                &app,
                "cleanup_auto_stash",
                &error,
                None,
                wrapper_id,
                Some(error_operation_id),
            );
            Err(error)
        }
    }
}

pub fn spawn_startup_reconcile(app: AppHandle, paths: AppPaths) {
    tauri::async_runtime::spawn_blocking(move || {
        let db = match Db::open(&paths) {
            Ok(db) => db,
            Err(error) => {
                tracing::warn!(error = %error, "branch reconcile could not open db");
                return;
            }
        };
        let manager = BranchManager::new(&db);
        let projects = match db.list_projects() {
            Ok(projects) => projects,
            Err(error) => {
                tracing::warn!(error = %error, "branch reconcile could not list projects");
                return;
            }
        };
        for project in projects {
            match manager.reconcile(&project.id) {
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(
                        project_id = %project.id,
                        error = ?error,
                        "branch reconcile failed"
                    );
                }
            }
            match repository_response(&db, &manager, &project.id) {
                Ok(response) => {
                    emit_repository_state(&app, &response.status);
                    for stash in &response.auto_stashes {
                        emit_auto_stash_changed(&app, stash);
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        project_id = %project.id,
                        error = ?error,
                        "branch reconcile status failed"
                    );
                }
            }
        }
    });
}

fn repository_response(
    db: &Db,
    manager: &BranchManager<'_>,
    project_id: &str,
) -> CommandResult<LocalBranchesResponse> {
    db.get_project(project_id)?;
    let snapshot = match manager.list(project_id) {
        Ok(snapshot) => snapshot,
        Err(CoreError::NotFound(_)) => return Ok(non_git_response(db, project_id)),
        Err(error) => return Err(error.into()),
    };
    let auto_stashes = manager
        .list_auto_stashes(project_id)?
        .into_iter()
        .map(|stash| auto_stash_record(manager, project_id, stash))
        .collect::<Vec<_>>();
    let worktrees = db.list_worktrees(project_id)?;
    let branches = snapshot
        .branches
        .iter()
        .map(|branch| {
            let checked_out_path = branch
                .occupied_worktree
                .as_ref()
                .filter(|path| path.as_str() != snapshot.repository_root)
                .cloned();
            let agent_port_worktree_id = checked_out_path.as_ref().and_then(|path| {
                worktrees
                    .iter()
                    .find(|worktree| worktree.path == *path)
                    .map(|worktree| worktree.id.clone())
            });
            LocalBranch {
                name: branch.name.clone(),
                oid: branch.oid.clone(),
                current: branch.current,
                checked_out_path,
                agent_port_worktree_id,
            }
        })
        .collect();
    let status = repository_status(db, project_id, &snapshot, auto_stashes.len())?;
    Ok(LocalBranchesResponse {
        status,
        branches,
        auto_stashes,
    })
}

fn non_git_response(db: &Db, project_id: &str) -> LocalBranchesResponse {
    LocalBranchesResponse {
        status: RepositoryStatus {
            project_id: project_id.to_owned(),
            is_git_repository: false,
            checkout_root: None,
            repo_key: None,
            head: RepositoryHead {
                kind: "unborn",
                branch: None,
                oid: None,
                short_oid: None,
            },
            changes: RepositoryChanges::default(),
            ongoing_operation: None,
            live_session_ids: live_session_ids(db, Some(project_id)).unwrap_or_default(),
            pending_auto_stashes: 0,
            observed_at: now_string(),
            snapshot_token: "non-git".into(),
        },
        branches: Vec::new(),
        auto_stashes: Vec::new(),
    }
}

fn repository_status(
    db: &Db,
    project_id: &str,
    snapshot: &BranchSnapshot,
    pending_auto_stashes: usize,
) -> CommandResult<RepositoryStatus> {
    let current_oid = snapshot
        .branches
        .iter()
        .find(|branch| branch.current)
        .map(|branch| branch.oid.clone());
    let head = match &snapshot.status.checkout {
        CheckoutState::Branch(branch) => RepositoryHead {
            kind: "branch",
            branch: Some(branch.clone()),
            short_oid: current_oid
                .as_ref()
                .map(|oid| oid.chars().take(12).collect()),
            oid: current_oid,
        },
        CheckoutState::Detached(oid) => RepositoryHead {
            kind: "detached",
            branch: None,
            oid: Some(oid.clone()),
            short_oid: Some(oid.chars().take(12).collect()),
        },
        CheckoutState::Unborn(branch) => RepositoryHead {
            kind: "unborn",
            branch: branch.clone(),
            oid: None,
            short_oid: None,
        },
    };
    let count = |paths: usize, present: bool| if present { paths.max(1) } else { 0 };
    let changes = RepositoryChanges {
        staged: count(
            snapshot
                .status
                .paths
                .iter()
                .filter(|path| path.staged)
                .count(),
            snapshot.status.staged,
        ),
        unstaged: count(
            snapshot
                .status
                .paths
                .iter()
                .filter(|path| path.unstaged)
                .count(),
            snapshot.status.unstaged,
        ),
        untracked: count(
            snapshot
                .status
                .paths
                .iter()
                .filter(|path| path.untracked)
                .count(),
            snapshot.status.untracked,
        ),
        unmerged: count(
            snapshot
                .status
                .paths
                .iter()
                .filter(|path| path.unmerged)
                .count(),
            snapshot.status.unmerged,
        ),
        dirty_submodules: count(
            snapshot
                .status
                .paths
                .iter()
                .filter(|path| path.submodule_dirty)
                .count(),
            snapshot.status.dirty_submodule,
        ),
    };
    let serialized = serde_json::to_vec(snapshot).map_err(CoreError::Json)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    serialized.hash(&mut hasher);
    Ok(RepositoryStatus {
        project_id: project_id.to_owned(),
        is_git_repository: true,
        checkout_root: Some(snapshot.repository_root.clone()),
        repo_key: Some(snapshot.repo_key.clone()),
        head,
        changes,
        ongoing_operation: snapshot.status.operation_state.clone(),
        live_session_ids: live_session_ids(db, Some(project_id))?,
        pending_auto_stashes,
        observed_at: now_string(),
        snapshot_token: format!("{:016x}", hasher.finish()),
    })
}

fn auto_stash_record(
    manager: &BranchManager<'_>,
    project_id: &str,
    stash: AutoStash,
) -> AutoStashRecord {
    let operation = manager.operation(&stash.operation_id).ok();
    let restorable = operation.as_ref().is_some_and(|operation| {
        operation.snapshot_json.is_some() && !operation.target_oid.is_empty()
    });
    let last_error = operation
        .and_then(|operation| operation.error_json)
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .map(redact_and_truncate)
        });
    let state = match stash.phase {
        BranchOperationPhase::Switched => "pending_restore",
        BranchOperationPhase::Stashed
        | BranchOperationPhase::Prepared
        | BranchOperationPhase::Applying
        | BranchOperationPhase::RecoveryRequired => "recovery_required",
        BranchOperationPhase::RestoredVerified => "restored_verified",
        BranchOperationPhase::Cleaning => "cleaning",
        BranchOperationPhase::Completed => "cleaned",
        BranchOperationPhase::Failed => "failed",
    };
    AutoStashRecord {
        id: stash.operation_id.clone(),
        operation_id: stash.operation_id,
        project_id: project_id.to_owned(),
        source_kind: if stash.source_branch.is_some() {
            "branch"
        } else {
            "detached"
        },
        source_branch: stash.source_branch,
        source_oid: Some(stash.source_commit),
        target_branch: stash.target_branch,
        stash_oid: Some(stash.oid),
        marker: stash.marker,
        created_at: stash
            .created_at
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        state: state.into(),
        last_error,
        restorable,
    }
}

async fn run_blocking<T, F>(
    paths: AppPaths,
    project_id: Option<String>,
    operation_id: String,
    command: &'static str,
    phase: &'static str,
    f: F,
) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Db, &BranchManager<'_>) -> CommandResult<T> + Send + 'static,
{
    let join_operation_id = operation_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = Db::open(&paths).map_err(|error| {
            CommandError::from_core(
                error,
                None,
                project_id.as_deref(),
                operation_id.clone(),
                command,
                phase,
            )
        })?;
        let manager = BranchManager::new(&db);
        f(&db, &manager).map_err(|error| {
            if error.code == "unsupported_core_api" {
                error
            } else {
                error.with_context(&db, project_id.as_deref(), command, phase, operation_id)
            }
        })
    })
    .await
    .map_err(|error| {
        CommandError::join_error(join_operation_id, command, phase, error.to_string())
    })?
}

/// Run a command that targets an already journaled branch operation. Resolve
/// the durable operation first so every later error can carry the authoritative
/// project, checkout status, live Sessions, and core operation ID.
async fn run_operation_blocking<T, F>(
    paths: AppPaths,
    operation_id: String,
    command: &'static str,
    phase: &'static str,
    f: F,
) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Db, &BranchManager<'_>, &BranchOperation) -> CommandResult<T> + Send + 'static,
{
    let join_operation_id = operation_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = Db::open(&paths).map_err(|error| {
            CommandError::from_core(error, None, None, operation_id.clone(), command, phase)
        })?;
        let manager = BranchManager::new(&db);
        let operation = manager.operation(&operation_id).map_err(|error| {
            CommandError::from_core(error, Some(&db), None, operation_id.clone(), command, phase)
        })?;
        let project_id = operation.project_id.clone();
        f(&db, &manager, &operation).map_err(|error| {
            error.with_context(&db, Some(&project_id), command, phase, operation_id)
        })
    })
    .await
    .map_err(|error| {
        CommandError::join_error(join_operation_id, command, phase, error.to_string())
    })?
}

impl CommandError {
    pub(crate) fn for_project_command(
        error: CoreError,
        db: Option<&Db>,
        project_id: Option<&str>,
        command: &'static str,
        phase: &'static str,
    ) -> Self {
        Self::from_core(
            error,
            db,
            project_id,
            wrapper_operation_id(command),
            command,
            phase,
        )
    }

    pub(crate) fn for_join(command: &'static str, phase: &'static str, message: String) -> Self {
        Self::join_error(wrapper_operation_id(command), command, phase, message)
    }

    fn from_core(
        error: CoreError,
        db: Option<&Db>,
        project_id: Option<&str>,
        operation_id: String,
        command: &'static str,
        phase: &'static str,
    ) -> Self {
        let code = core_error_code(&error);
        let recoverable = is_recoverable(&error);
        let message = redact_and_truncate(&error.to_string());
        let current_status = db.and_then(|db| current_status(db, project_id));
        let live_session_ids = db
            .and_then(|db| live_session_ids(db, project_id).ok())
            .unwrap_or_default();
        let recovery_action_codes = recovery_action_codes(code, command, recoverable);
        Self {
            code: code.into(),
            message: message.clone(),
            phase: phase.into(),
            operation_id,
            recoverable,
            current_status,
            recovery_actions: recovery_actions(&recovery_action_codes),
            recovery_action_codes,
            diagnostics: json!({
                "command": command,
                "message": message,
            }),
            live_session_ids,
        }
    }

    fn join_error(
        operation_id: String,
        command: &'static str,
        phase: &'static str,
        message: String,
    ) -> Self {
        let message = redact_and_truncate(&message);
        Self {
            code: "join_error".into(),
            message: message.clone(),
            phase: phase.into(),
            operation_id,
            recoverable: true,
            current_status: None,
            recovery_actions: vec![
                "Retry the operation after checking the app diagnostics log.".into(),
            ],
            recovery_action_codes: vec!["retry_after_checking_diagnostics".into()],
            diagnostics: json!({
                "command": command,
                "message": message,
            }),
            live_session_ids: Vec::new(),
        }
    }

    fn with_context(
        mut self,
        db: &Db,
        project_id: Option<&str>,
        command: &'static str,
        phase: &'static str,
        operation_id: String,
    ) -> Self {
        // `From<CoreError>` has no command context and therefore uses a
        // generated placeholder. Replace only that placeholder; errors already
        // mapped by an operation-aware layer keep their durable core ID.
        if self.operation_id.starts_with("tauri_core_error_") {
            self.operation_id = operation_id;
        }
        if self.phase == "failed" {
            self.phase = phase.into();
        }
        if self.current_status.is_none() {
            self.current_status = current_status(db, project_id);
        }
        if self.live_session_ids.is_empty() {
            self.live_session_ids = live_session_ids(db, project_id).unwrap_or_default();
        }
        if let Some(obj) = self.diagnostics.as_object_mut() {
            obj.insert("command".into(), json!(command));
        }
        self
    }
}

impl From<CoreError> for CommandError {
    fn from(error: CoreError) -> Self {
        CommandError::from_core(
            error,
            None,
            None,
            wrapper_operation_id("core_error"),
            "unknown",
            "failed",
        )
    }
}

fn parse_restore_strategy(
    strategy: Option<String>,
) -> agentport_core::error::Result<RestoreStrategy> {
    match strategy.as_deref().unwrap_or("target") {
        "target" => Ok(RestoreStrategy::Target),
        "source" => Ok(RestoreStrategy::Source),
        other => Err(CoreError::Validation(format!(
            "unsupported restore strategy: {other}"
        ))),
    }
}

fn current_status(db: &Db, project_id: Option<&str>) -> Option<RepositoryStatus> {
    let project_id = project_id?;
    repository_response(db, &BranchManager::new(db), project_id)
        .ok()
        .map(|response| response.status)
}

fn live_session_ids(
    db: &Db,
    project_id: Option<&str>,
) -> agentport_core::error::Result<Vec<String>> {
    let Some(project_id) = project_id else {
        return Ok(Vec::new());
    };
    let project = db.get_project(project_id)?;
    let runner = GitRunner::default();
    let target = RepositoryIdentity::from_project(&project, &runner).ok();
    let mut ids = Vec::new();
    for session in db.list_sessions(None, false)? {
        if !matches!(session.lifecycle, Lifecycle::Creating | Lifecycle::Running) {
            continue;
        }
        let same_checkout = target.as_ref().is_some_and(|target| {
            RepositoryIdentity::discover(std::path::Path::new(&session.cwd), &runner)
                .is_ok_and(|session_repository| session_repository.root == target.root)
        });
        if same_checkout || (target.is_none() && session.project_id == project_id) {
            ids.push(session.id);
        }
    }
    Ok(ids)
}

fn core_error_code(error: &CoreError) -> &'static str {
    match error {
        CoreError::Validation(_) => "validation",
        CoreError::NotFound(_) => "not_found",
        CoreError::Conflict(_) => "conflict",
        CoreError::Io(_) => "io",
        CoreError::Sqlite(_) => "sqlite",
        CoreError::Json(_) => "json",
        CoreError::Git(_) => "git",
        CoreError::Host(_) => "host",
        CoreError::Adapter(_) => "adapter",
        CoreError::SecretStoreUnavailable(_) => "secret_store_unavailable",
        CoreError::SecretStore(_) => "secret_store",
        CoreError::Redaction(_) => "redaction",
        CoreError::Export(_) => "export",
        CoreError::Protocol(_) => "protocol",
        CoreError::RuntimeMessage { .. } => "protocol",
        CoreError::Timeout(_) => "timeout",
        CoreError::Blocked(_) => "blocked",
        CoreError::Internal(_) => "internal",
    }
}

fn is_recoverable(error: &CoreError) -> bool {
    matches!(
        error,
        CoreError::Validation(_)
            | CoreError::NotFound(_)
            | CoreError::Conflict(_)
            | CoreError::Git(_)
            | CoreError::Timeout(_)
            | CoreError::Blocked(_)
    )
}

fn recovery_action_codes(code: &str, command: &'static str, recoverable: bool) -> Vec<String> {
    if !recoverable {
        return vec!["check_diagnostics_and_retry".into()];
    }
    match (code, command) {
        ("blocked", "create_worktree") => vec!["refresh_and_choose_available_branch".into()],
        ("conflict" | "not_found", "create_worktree") => {
            vec!["refresh_and_reselect_branch".into()]
        }
        ("blocked", _) => vec!["resolve_repository_blockers".into()],
        ("conflict", "restore_auto_stash") => vec![
            "inspect_retained_auto_stash".into(),
            "restore_when_checkout_safe".into(),
        ],
        ("conflict", _) => vec!["choose_nonconflicting_action".into()],
        ("git", _) | ("timeout", _) => vec![
            "refresh_repository_before_retry".into(),
            "inspect_diagnostics_if_git_unavailable".into(),
        ],
        _ => vec!["refresh_repository_and_retry".into()],
    }
}

fn recovery_actions(codes: &[String]) -> Vec<String> {
    codes
        .iter()
        .map(|code| match code.as_str() {
            "check_diagnostics_and_retry" => {
                "Check AgentPort diagnostics and retry after the underlying issue is fixed."
            }
            "refresh_and_choose_available_branch" => {
                "Refresh local branches and choose one that is not checked out in any Worktree."
            }
            "refresh_and_reselect_branch" => {
                "Refresh local branches and reselect the branch before creating the Worktree."
            }
            "resolve_repository_blockers" => {
                "Resolve active sessions, dirty submodules, merge/rebase state, or index conflicts, then retry."
            }
            "inspect_retained_auto_stash" => {
                "Use list_auto_stashes to inspect the retained operation."
            }
            "restore_when_checkout_safe" => {
                "Choose source or target restore only when the checkout is safe."
            }
            "choose_nonconflicting_action" => {
                "Refresh repository status and choose a non-conflicting branch/action."
            }
            "refresh_repository_before_retry" => "Refresh repository status before retrying.",
            "inspect_diagnostics_if_git_unavailable" => {
                "Inspect the app diagnostics log if Git remains unavailable."
            }
            "retry_after_checking_diagnostics" => {
                "Retry the operation after checking the app diagnostics log."
            }
            _ => "Refresh repository status and retry.",
        })
        .map(str::to_string)
        .collect()
}

fn emit_repository_state(app: &AppHandle, status: &RepositoryStatus) {
    let _ = app.emit("repository-state-changed", status);
}

fn emit_auto_stash_changed(app: &AppHandle, stash: &AutoStashRecord) {
    let _ = app.emit("auto-stash-changed", stash);
}

fn emit_progress(app: &AppHandle, payload: RepositoryOperationProgress) {
    let _ = app.emit("repo-operation-progress", payload);
}

fn emit_error_progress(
    app: &AppHandle,
    command: &'static str,
    error: &CommandError,
    branch: Option<String>,
    event_operation_id: String,
    core_operation_id: Option<String>,
) {
    emit_progress(
        app,
        RepositoryOperationProgress {
            operation_id: event_operation_id,
            command,
            project_id: error
                .current_status
                .as_ref()
                .map(|status| status.project_id.clone()),
            branch,
            phase: "failed".into(),
            message: error.message.clone(),
            core_operation_id: core_operation_id.or_else(|| {
                error
                    .operation_id
                    .starts_with("op_")
                    .then(|| error.operation_id.clone())
            }),
            recoverable: error.recoverable,
            occurred_at: now_string(),
        },
    );
}

fn wrapper_operation_id(prefix: &str) -> String {
    format!(
        "tauri_{}_{}",
        prefix,
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    )
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn redact_and_truncate(value: &str) -> String {
    let mut redacted = redact_url_credentials(value);
    redacted = redacted
        .lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            if lower.contains("password")
                || lower.contains("api_key")
                || lower.contains("apikey")
                || lower.contains("access_token")
                || lower.contains("secret")
            {
                "[redacted diagnostic line]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    const MAX_DIAGNOSTIC_CHARS: usize = 1600;
    if redacted.chars().count() <= MAX_DIAGNOSTIC_CHARS {
        return redacted;
    }
    let mut truncated = redacted
        .chars()
        .take(MAX_DIAGNOSTIC_CHARS)
        .collect::<String>();
    truncated.push_str("…[truncated]");
    truncated
}

fn redact_url_credentials(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(scheme_pos) = rest.find("://") {
        let (before, after_scheme) = rest.split_at(scheme_pos + 3);
        out.push_str(before);
        let after = after_scheme;
        let slash = after.find('/').unwrap_or(after.len());
        let at = after[..slash].rfind('@');
        if let Some(at) = at {
            out.push_str("***@");
            rest = &after[at + 1..];
        } else {
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentport_core::ids;
    use agentport_core::models::Project;

    fn add_project(db: &Db, root_path: String) -> String {
        let project_id = ids::new_id("prj_git_command");
        db.add_project(&Project {
            id: project_id.clone(),
            name: "git command test".into(),
            root_path,
            git_root_path: None,
            created_at: Utc::now(),
        })
        .unwrap();
        project_id
    }

    #[test]
    fn repository_response_maps_only_not_found_to_non_git() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let non_git_root = temp.path().join("plain-project");
        std::fs::create_dir_all(&non_git_root).unwrap();
        let project_id = add_project(&db, non_git_root.to_string_lossy().into_owned());
        let response = repository_response(&db, &BranchManager::new(&db), &project_id).unwrap();
        assert!(!response.status.is_git_repository);

        let missing_project_id = add_project(
            &db,
            temp.path()
                .join("missing-project")
                .to_string_lossy()
                .into_owned(),
        );
        let error =
            repository_response(&db, &BranchManager::new(&db), &missing_project_id).unwrap_err();
        assert_eq!(error.code, "validation");
    }

    #[test]
    fn adding_context_preserves_core_operation_and_existing_observations() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let root = temp.path().join("plain-project");
        std::fs::create_dir_all(&root).unwrap();
        let project_id = add_project(&db, root.to_string_lossy().into_owned());
        let observed = non_git_response(&db, &project_id).status;
        let error = CommandError {
            code: "conflict".into(),
            message: "restore conflict".into(),
            phase: "restore_conflict".into(),
            operation_id: "op_durable".into(),
            recoverable: true,
            current_status: Some(observed),
            recovery_actions: vec!["keep stash".into()],
            recovery_action_codes: vec!["inspect_retained_auto_stash".into()],
            diagnostics: json!({"message": "restore conflict"}),
            live_session_ids: vec!["ses_observed".into()],
        }
        .with_context(
            &db,
            Some(&project_id),
            "restore_auto_stash",
            "restore",
            "tauri_wrapper".into(),
        );

        assert_eq!(error.operation_id, "op_durable");
        assert_eq!(error.phase, "restore_conflict");
        assert_eq!(
            error.current_status.as_ref().unwrap().snapshot_token,
            "non-git"
        );
        assert_eq!(error.live_session_ids, ["ses_observed"]);
    }

    #[test]
    fn placeholder_core_error_receives_command_context() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(temp.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        let error = CommandError::from(CoreError::Conflict("busy".into())).with_context(
            &db,
            None,
            "switch_local_branch",
            "switch",
            "tauri_switch_1".into(),
        );
        assert_eq!(error.operation_id, "tauri_switch_1");
        assert_eq!(error.phase, "switch");
    }
}
