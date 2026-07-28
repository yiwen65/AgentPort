//! Tauri boundary for the checkout-scoped Git Center.
//!
//! The renderer can identify only persisted Projects, Worktrees, Sessions,
//! and backend-issued opaque path tokens. Repository paths never cross this
//! command boundary as request parameters.

use agentport_core::db::Db;
use agentport_core::error::CoreError;
use agentport_core::git::{
    GitChangesSnapshot, GitCheckoutDescriptor, GitCommitDetail, GitCommitPatch, GitCommitResult,
    GitCommitReview, GitContextLocator, GitDiffSide, GitFileDiff, GitHistoryPage, GitIgnoreTarget,
    GitMutationResult, GitPathSelection, GitRemoteAction, GitResolvedFile, GitWorkspaceManager,
};
use agentport_core::paths::AppPaths;
use chrono::{SecondsFormat, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

type CommandResult<T> = std::result::Result<T, GitWorkspaceCommandError>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitWorkspaceCommandError {
    code: &'static str,
    message: String,
    recoverable: bool,
    current_changes: Option<Box<GitChangesSnapshot>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStateInvalidated {
    repo_key: String,
    checkout_ids: Vec<String>,
    scopes: Vec<&'static str>,
    reason: &'static str,
    operation_id: String,
    observed_at: String,
}

#[tauri::command]
pub async fn resolve_git_context(
    state: State<'_, AppState>,
    locator: GitContextLocator,
) -> CommandResult<GitCheckoutDescriptor> {
    run_read(state.paths.clone(), move |manager| {
        manager.resolve(&locator)
    })
    .await
}

#[tauri::command]
pub async fn adopt_git_worktree_branch(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_branch: String,
    actual_branch: String,
) -> CommandResult<GitChangesSnapshot> {
    let error_locator = locator.clone();
    let changes = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.adopt_current_worktree_branch(
            &locator,
            &expected_checkout_id,
            &expected_branch,
            &actual_branch,
        )?;
        manager.changes(&locator, true)
    })
    .await?;
    emit_invalidation(
        &app,
        &changes,
        &format!("branch-adopt-{}", Utc::now().timestamp_millis()),
        "branchAdopted",
        &["refs", "changes", "history"],
    );
    Ok(changes)
}

#[tauri::command]
pub async fn get_git_changes(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    include_ignored: Option<bool>,
) -> CommandResult<GitChangesSnapshot> {
    run_read(state.paths.clone(), move |manager| {
        manager.changes(&locator, include_ignored.unwrap_or(true))
    })
    .await
}

#[tauri::command]
pub async fn get_git_diff(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    expected_status_token: String,
    side: GitDiffSide,
    path_token: String,
) -> CommandResult<GitFileDiff> {
    run_read(state.paths.clone(), move |manager| {
        manager.diff(&locator, &expected_status_token, side, &path_token)
    })
    .await
}

#[tauri::command]
pub async fn get_git_history(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    cursor: Option<String>,
    limit: Option<usize>,
) -> CommandResult<GitHistoryPage> {
    run_read(state.paths.clone(), move |manager| {
        manager.history(&locator, cursor.as_deref(), limit.unwrap_or(50))
    })
    .await
}

#[tauri::command]
pub async fn get_git_commit_detail(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    commit_oid: String,
) -> CommandResult<GitCommitDetail> {
    run_read(state.paths.clone(), move |manager| {
        manager.commit_detail(&locator, &commit_oid)
    })
    .await
}

#[tauri::command]
pub async fn get_git_commit_diff(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    commit_oid: String,
    parent_oid: Option<String>,
    path_token: Option<String>,
) -> CommandResult<GitCommitPatch> {
    run_read(state.paths.clone(), move |manager| {
        manager.commit_diff(
            &locator,
            &commit_oid,
            parent_oid.as_deref(),
            path_token.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn stage_git_paths(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selections: Vec<GitPathSelection>,
) -> CommandResult<GitMutationResult> {
    let error_locator = locator.clone();
    let result = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.stage_paths(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            &selections,
        )
    })
    .await?;
    emit_invalidation(
        &app,
        &result.changes,
        &result.operation_id,
        "stage",
        &["index", "changes", "diff", "commitReview"],
    );
    Ok(result)
}

#[tauri::command]
pub async fn unstage_git_paths(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selections: Vec<GitPathSelection>,
) -> CommandResult<GitMutationResult> {
    let error_locator = locator.clone();
    let result = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.unstage_paths(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            &selections,
        )
    })
    .await?;
    emit_invalidation(
        &app,
        &result.changes,
        &result.operation_id,
        "unstage",
        &["index", "changes", "diff", "commitReview"],
    );
    Ok(result)
}

#[tauri::command]
pub async fn discard_git_paths(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selections: Vec<GitPathSelection>,
) -> CommandResult<GitMutationResult> {
    let error_locator = locator.clone();
    let result = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.discard_paths(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            &selections,
        )
    })
    .await?;
    emit_invalidation(
        &app,
        &result.changes,
        &result.operation_id,
        "discard",
        &["changes", "diff", "commitReview"],
    );
    Ok(result)
}

#[tauri::command]
pub async fn add_git_ignore(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selection: GitPathSelection,
    target: GitIgnoreTarget,
) -> CommandResult<GitMutationResult> {
    let error_locator = locator.clone();
    let result = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.ignore_path(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            &selection,
            target,
        )
    })
    .await?;
    emit_invalidation(
        &app,
        &result.changes,
        &result.operation_id,
        "ignore",
        &["changes", "diff", "commitReview"],
    );
    Ok(result)
}

#[tauri::command]
pub async fn trash_git_path(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selection: GitPathSelection,
) -> CommandResult<GitMutationResult> {
    let error_locator = locator.clone();
    let result = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.trash_path(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            &selection,
            move_to_trash,
        )
    })
    .await?;
    emit_invalidation(
        &app,
        &result.changes,
        &result.operation_id,
        "trash",
        &["changes", "diff", "commitReview"],
    );
    Ok(result)
}

#[tauri::command]
pub async fn resolve_git_file(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    selection: GitPathSelection,
) -> CommandResult<GitResolvedFile> {
    run_read(state.paths.clone(), move |manager| {
        manager.resolve_file(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            &selection,
        )
    })
    .await
}

#[tauri::command]
pub async fn sync_git_remote(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    action: GitRemoteAction,
) -> CommandResult<GitMutationResult> {
    let error_locator = locator.clone();
    let result = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.sync_remote(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            action,
        )
    })
    .await?;
    let _ = app.emit(
        "git-state-invalidated",
        GitStateInvalidated {
            repo_key: result.changes.context.repo_key.clone(),
            checkout_ids: Vec::new(),
            scopes: vec![
                "refs",
                "index",
                "changes",
                "diff",
                "history",
                "commitReview",
            ],
            reason: "remoteSync",
            operation_id: result.operation_id.clone(),
            observed_at: now_string(),
        },
    );
    Ok(result)
}

#[tauri::command]
pub async fn prepare_git_commit(
    state: State<'_, AppState>,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_status_token: String,
    message: String,
) -> CommandResult<GitCommitReview> {
    run_read(state.paths.clone(), move |manager| {
        manager.prepare_commit(
            &locator,
            &expected_checkout_id,
            &expected_status_token,
            &message,
        )
    })
    .await
}

#[tauri::command]
pub async fn commit_git_changes(
    state: State<'_, AppState>,
    app: AppHandle,
    locator: GitContextLocator,
    expected_checkout_id: String,
    expected_commit_token: String,
    message: String,
) -> CommandResult<GitCommitResult> {
    let error_locator = locator.clone();
    let result = run_write(state.paths.clone(), error_locator, move |manager| {
        manager.commit_changes(
            &locator,
            &expected_checkout_id,
            &expected_commit_token,
            &message,
        )
    })
    .await?;
    emit_invalidation(
        &app,
        &result.changes,
        &result.operation_id,
        "commit",
        &[
            "refs",
            "index",
            "changes",
            "diff",
            "history",
            "commitReview",
        ],
    );
    Ok(result)
}

pub fn spawn_startup_reconcile(app: AppHandle, paths: AppPaths) {
    tauri::async_runtime::spawn_blocking(move || {
        let db = match Db::open(&paths) {
            Ok(db) => db,
            Err(error) => {
                tracing::warn!(error = %error, "Git commit recovery could not open db");
                return;
            }
        };
        let manager = GitWorkspaceManager::new_with_paths(&db, &paths);
        let recoveries = match manager.reconcile_commit_operations() {
            Ok(recoveries) => recoveries,
            Err(error) => {
                tracing::warn!(error = %error, "Git commit recovery failed");
                return;
            }
        };
        for recovery in recoveries {
            let _ = app.emit(
                "git-state-invalidated",
                GitStateInvalidated {
                    repo_key: recovery.repo_key,
                    checkout_ids: vec![recovery.checkout_id],
                    scopes: vec![
                        "refs",
                        "index",
                        "changes",
                        "diff",
                        "history",
                        "commitReview",
                    ],
                    reason: "commitRecovery",
                    operation_id: recovery.operation_id,
                    observed_at: now_string(),
                },
            );
        }
    });
}

async fn run_read<T, F>(paths: AppPaths, operation: F) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce(&GitWorkspaceManager<'_>) -> agentport_core::error::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let db = Db::open(&paths).map_err(GitWorkspaceCommandError::from)?;
        operation(&GitWorkspaceManager::new_with_paths(&db, &paths))
            .map_err(GitWorkspaceCommandError::from)
    })
    .await
    .map_err(|error| GitWorkspaceCommandError {
        code: "internal",
        message: format!("Git command worker stopped: {error}"),
        recoverable: true,
        current_changes: None,
    })?
}

async fn run_write<T, F>(
    paths: AppPaths,
    locator: GitContextLocator,
    operation: F,
) -> CommandResult<T>
where
    T: Send + 'static,
    F: FnOnce(&GitWorkspaceManager<'_>) -> agentport_core::error::Result<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let db = Db::open(&paths).map_err(GitWorkspaceCommandError::from)?;
        let manager = GitWorkspaceManager::new_with_paths(&db, &paths);
        operation(&manager).map_err(|error| {
            let mut error = GitWorkspaceCommandError::from(error);
            error.current_changes = manager.changes(&locator, true).ok().map(Box::new);
            error
        })
    })
    .await
    .map_err(|error| GitWorkspaceCommandError {
        code: "internal",
        message: format!("Git command worker stopped: {error}"),
        recoverable: true,
        current_changes: None,
    })?
}

fn emit_invalidation(
    app: &AppHandle,
    changes: &GitChangesSnapshot,
    operation_id: &str,
    reason: &'static str,
    scopes: &[&'static str],
) {
    let _ = app.emit(
        "git-state-invalidated",
        GitStateInvalidated {
            repo_key: changes.context.repo_key.clone(),
            checkout_ids: vec![changes.context.checkout_id.clone()],
            scopes: scopes.to_vec(),
            reason,
            operation_id: operation_id.to_owned(),
            observed_at: now_string(),
        },
    );
}

fn now_string() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &std::path::Path) -> agentport_core::error::Result<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let path = NSString::from_str(&path.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path);
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| std::io::Error::other(format!("move file to macOS Trash: {error}")).into())
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(_path: &std::path::Path) -> agentport_core::error::Result<()> {
    Err(CoreError::Blocked(
        "moving Git files to Trash is currently supported on macOS".into(),
    ))
}

impl From<CoreError> for GitWorkspaceCommandError {
    fn from(error: CoreError) -> Self {
        let (code, recoverable) = match &error {
            CoreError::Validation(_) => ("validation", true),
            CoreError::NotFound(_) => ("notFound", true),
            CoreError::Conflict(_) => ("stale", true),
            CoreError::Timeout(_) => ("timeout", true),
            CoreError::Blocked(_) => ("blocked", true),
            CoreError::Git(_) => ("git", true),
            CoreError::Io(_) => ("io", true),
            CoreError::Sqlite(_) => ("storage", false),
            CoreError::Json(_) => ("internal", false),
            CoreError::Host(_)
            | CoreError::Adapter(_)
            | CoreError::SecretStoreUnavailable(_)
            | CoreError::SecretStore(_)
            | CoreError::Redaction(_)
            | CoreError::Export(_)
            | CoreError::Protocol(_)
            | CoreError::RuntimeMessage { .. }
            | CoreError::Internal(_) => ("internal", false),
        };
        Self {
            code,
            message: error.to_string(),
            recoverable,
            current_changes: None,
        }
    }
}
