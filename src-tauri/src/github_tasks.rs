//! Read-only GitHub task discovery for the local desktop project.
//!
//! Authentication remains owned by the user's `gh` installation. This module
//! never reads, persists, or logs credentials; it only passes bounded,
//! repository-scoped read requests to `gh api`.

use agentport_core::db::Db;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

use crate::task_options::{TaskOption, TaskOptionsEnvelope};
use crate::AppState;
use agentport_core::task_remote::{
    github_repository, gitlab_project_path, is_valid_project_path, parse_remote,
    provider_for_remote, resolve_main_remote, TaskProvider,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
const MAX_ITEMS: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProviderDetection {
    pub provider: Option<String>,
    pub host: Option<String>,
    pub remote_url: Option<String>,
    pub repository: Option<String>,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

impl TaskProviderDetection {
    fn failed(code: &str, message: impl Into<String>) -> Self {
        Self {
            provider: None,
            host: None,
            remote_url: None,
            repository: None,
            error_code: Some(code.into()),
            error: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskEnvelope {
    pub scope: String,
    pub repository: Option<GithubRepository>,
    pub capabilities: GithubTaskCapabilities,
    pub data: Option<GithubTaskData>,
    pub error: Option<GithubTaskError>,
}

/// Provider capabilities are returned with every read so the renderer never
/// has to guess which mutation controls are safe to show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskCapabilities {
    pub comments: bool,
    pub status: bool,
    pub labels: bool,
    pub assignees: bool,
    pub reviews: bool,
    pub checks: bool,
    pub projects: bool,
    pub project_writes: bool,
    pub merge: bool,
}

fn github_capabilities() -> GithubTaskCapabilities {
    GithubTaskCapabilities {
        comments: true,
        status: true,
        labels: true,
        assignees: true,
        reviews: true,
        checks: true,
        projects: true,
        project_writes: true,
        merge: true,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub host: String,
    pub owner: String,
    pub name: String,
    pub remote_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", content = "items", rename_all = "camelCase")]
pub enum GithubTaskData {
    Issues(Vec<GithubIssue>),
    Pulls(Vec<GithubPullRequest>),
    Projects(Vec<GithubProject>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssue {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: Option<String>,
    pub updated_at: Option<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullRequest {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: Option<String>,
    pub updated_at: Option<String>,
    pub draft: bool,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubProject {
    pub number: u64,
    pub title: String,
    pub url: Option<String>,
    pub short_description: Option<String>,
    pub updated_at: Option<String>,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskComment {
    pub id: String,
    pub author: Option<String>,
    pub body: String,
    pub created_at: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskReview {
    pub id: String,
    pub author: Option<String>,
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskCheck {
    pub name: String,
    pub state: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskDetail {
    pub id: String,
    pub kind: String,
    pub number: u64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub author: Option<String>,
    pub updated_at: Option<String>,
    pub body: String,
    pub draft: bool,
    pub merged: bool,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub comments: Vec<GithubTaskComment>,
    pub reviews: Vec<GithubTaskReview>,
    pub checks: Vec<GithubTaskCheck>,
    pub source_revision: Option<String>,
    pub repository: GithubRepository,
    pub partial: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubTaskMutationRequest {
    pub kind: String,
    pub number: u64,
    pub operation: String,
    pub title: Option<String>,
    pub head: Option<String>,
    pub base: Option<String>,
    pub draft: Option<bool>,
    pub body: Option<String>,
    pub state: Option<String>,
    pub labels: Option<Vec<String>>,
    pub assignees: Option<Vec<String>>,
    pub review_event: Option<String>,
    pub merge_method: Option<String>,
    pub project_number: Option<u64>,
    pub project_id: Option<String>,
    pub item_id: Option<String>,
    pub field_id: Option<String>,
    pub field_value: Option<String>,
    pub expected_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskDetailEnvelope {
    pub repository: Option<GithubRepository>,
    pub capabilities: GithubTaskCapabilities,
    pub data: Option<GithubTaskDetail>,
    pub error: Option<GithubTaskError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskMutationOutcome {
    pub status: String,
    pub data: Option<GithubTaskDetail>,
    pub error: Option<GithubTaskError>,
    pub read_back_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteIdentity {
    owner: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct IssueApi {
    number: u64,
    title: String,
    state: String,
    html_url: String,
    user: Option<UserApi>,
    updated_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    labels: Vec<LabelApi>,
    #[serde(default)]
    assignees: Vec<UserApi>,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct PullApi {
    number: u64,
    title: String,
    state: String,
    html_url: String,
    user: Option<UserApi>,
    updated_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    labels: Vec<LabelApi>,
    #[serde(default)]
    assignees: Vec<UserApi>,
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    head: Option<HeadApi>,
}

#[derive(Debug, Deserialize)]
struct UserApi {
    login: String,
}

#[derive(Debug, Deserialize)]
struct LabelApi {
    name: String,
}

#[derive(Debug, Deserialize)]
struct HeadApi {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GraphQlResponse {
    data: Option<GraphQlData>,
    errors: Option<Vec<GraphQlError>>,
}

#[derive(Debug, Deserialize)]
struct GraphQlError {
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GraphQlData {
    repository: Option<GraphQlRepository>,
}

#[derive(Debug, Deserialize)]
struct GraphQlRepository {
    #[serde(rename = "projectsV2")]
    projects: GraphQlProjects,
}

#[derive(Debug, Deserialize)]
struct GraphQlProjects {
    nodes: Vec<Option<GraphQlProject>>,
}

#[derive(Debug, Deserialize)]
struct GraphQlProject {
    number: u64,
    title: String,
    url: Option<String>,
    #[serde(rename = "shortDescription")]
    short_description: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
    closed: bool,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[tauri::command]
pub async fn detect_task_provider(
    state: State<'_, AppState>,
    project_id: String,
) -> std::result::Result<TaskProviderDetection, String> {
    let paths = state.paths.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        detect_task_provider_blocking(&paths, &project_id)
    })
    .await;
    Ok(match result {
        Ok(value) => value,
        Err(error) => TaskProviderDetection::failed("backend_unavailable", error.to_string()),
    })
}

#[tauri::command]
pub async fn get_github_task_options(
    state: State<'_, AppState>,
    project_id: String,
) -> std::result::Result<TaskOptionsEnvelope, String> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        load_github_task_options(&paths, &project_id)
            .unwrap_or_else(|error| TaskOptionsEnvelope::error(error.0, error.1))
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn upload_github_task_image(
    state: State<'_, AppState>,
    project_id: String,
    file_name: String,
    content_type: String,
    content_base64: String,
) -> std::result::Result<String, String> {
    let paths = state.paths.clone();
    tauri::async_runtime::spawn_blocking(move || {
        upload_github_task_image_blocking(
            &paths,
            &project_id,
            &file_name,
            &content_type,
            &content_base64,
        )
        .map_err(|error| error.1)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_github_tasks(
    state: State<'_, AppState>,
    project_id: String,
    scope: String,
) -> std::result::Result<GithubTaskEnvelope, String> {
    let paths = state.paths.clone();
    let fallback_scope = scope.clone();
    let envelope =
        match tauri::async_runtime::spawn_blocking(move || load_tasks(&paths, &project_id, &scope))
            .await
        {
            Ok(envelope) => envelope,
            Err(error) => {
                GithubTaskEnvelope::error(&fallback_scope, "backend_unavailable", error.to_string())
            }
        };
    Ok(envelope)
}

/// Read one issue or pull request with its comments, reviews, and checks.
/// Every child request remains bounded; optional child failures are surfaced as
/// warnings instead of silently turning a partial detail into a false empty
/// result.
#[tauri::command]
pub async fn get_github_task(
    state: State<'_, AppState>,
    project_id: String,
    kind: String,
    number: u64,
) -> std::result::Result<GithubTaskDetailEnvelope, String> {
    let paths = state.paths.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        load_github_detail(&paths, &project_id, &kind, number)
    })
    .await;
    Ok(match result {
        Ok(envelope) => envelope,
        Err(error) => GithubTaskDetailEnvelope::error("backend_unavailable", error.to_string()),
    })
}

/// Execute one guarded provider mutation. The command never reports success
/// until a fresh provider read succeeds. A timeout/transport failure after the
/// write may have reached the provider, so it is deliberately represented as
/// `unknown` and is never retried automatically.
#[tauri::command]
pub async fn mutate_github_task(
    state: State<'_, AppState>,
    project_id: String,
    request: GithubTaskMutationRequest,
) -> std::result::Result<GithubTaskMutationOutcome, String> {
    let paths = state.paths.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        mutate_github_task_blocking(&paths, &project_id, request)
    })
    .await;
    Ok(match result {
        Ok(outcome) => outcome,
        Err(error) => GithubTaskMutationOutcome::unknown("backend_unavailable", error.to_string()),
    })
}

fn load_tasks(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
    scope: &str,
) -> GithubTaskEnvelope {
    let mut envelope = GithubTaskEnvelope::empty(scope);
    let db = match Db::open_read(paths) {
        Ok(db) => db,
        Err(error) => return envelope.with_error("project_read_failed", error.to_string()),
    };
    let project = match db.get_project(project_id) {
        Ok(project) => project,
        Err(error) => return envelope.with_error("project_not_found", error.to_string()),
    };
    let requested_scope = match scope {
        "issues" | "pulls" | "projects" => scope,
        _ => {
            return envelope.with_error(
                "invalid_scope",
                "scope must be issues, pulls, or projects".into(),
            )
        }
    };

    let checkout = project
        .git_root_path
        .as_deref()
        .unwrap_or(&project.root_path);
    let root = match git_root(checkout) {
        Ok(root) => root,
        Err(error) => return envelope.with_error(error.0, error.1),
    };
    let (identity, remote_url) = match github_remote(&root) {
        Ok(remote) => remote,
        Err(error) => return envelope.with_error(error.0, error.1),
    };
    envelope.repository = Some(GithubRepository {
        host: "github.com".into(),
        owner: identity.owner.clone(),
        name: identity.name.clone(),
        remote_url,
    });

    let result = match requested_scope {
        "issues" => fetch_issues(&root, &identity),
        "pulls" => fetch_pulls(&root, &identity),
        "projects" => fetch_projects(&root, &identity),
        _ => unreachable!(),
    };
    match result {
        Ok(data) => envelope.data = Some(data),
        Err(error) => {
            envelope.error = Some(GithubTaskError {
                code: error.0.into(),
                message: error.1,
            })
        }
    }
    envelope
}

fn resolve_github_checkout(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
) -> Result<(String, GithubRepository, RemoteIdentity), (&'static str, String)> {
    let db = Db::open_read(paths).map_err(|error| ("project_read_failed", error.to_string()))?;
    let project = db
        .get_project(project_id)
        .map_err(|error| ("project_not_found", error.to_string()))?;
    let checkout = project
        .git_root_path
        .as_deref()
        .unwrap_or(&project.root_path);
    let root = git_root(checkout)?;
    let (identity, remote_url) = github_remote(&root)?;
    let repository = GithubRepository {
        host: "github.com".into(),
        owner: identity.owner.clone(),
        name: identity.name.clone(),
        remote_url,
    };
    Ok((root, repository, identity))
}

fn load_github_detail(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
    kind: &str,
    number: u64,
) -> GithubTaskDetailEnvelope {
    let (root, repository, identity) = match resolve_github_checkout(paths, project_id) {
        Ok(value) => value,
        Err(error) => return GithubTaskDetailEnvelope::error(error.0, error.1),
    };
    match fetch_github_detail(&root, &identity, &repository, kind, number) {
        Ok(detail) => GithubTaskDetailEnvelope {
            repository: Some(repository),
            capabilities: github_capabilities(),
            data: Some(detail),
            error: None,
        },
        Err(error) => GithubTaskDetailEnvelope {
            repository: Some(repository),
            capabilities: github_capabilities(),
            data: None,
            error: Some(GithubTaskError {
                code: error.0.into(),
                message: error.1,
            }),
        },
    }
}

fn fetch_github_detail(
    root: &str,
    identity: &RemoteIdentity,
    repository: &GithubRepository,
    kind: &str,
    number: u64,
) -> Result<GithubTaskDetail, (&'static str, String)> {
    if number == 0 {
        return Err((
            "invalid_task",
            "Task number must be greater than zero".into(),
        ));
    }
    let kind = normalize_github_kind(kind)
        .ok_or(("invalid_kind", "kind must be issue or pull_request".into()))?;
    let segment = if kind == "pull_request" {
        "pulls"
    } else {
        "issues"
    };
    let endpoint = format!(
        "repos/{}/{}/{segment}/{number}",
        identity.owner, identity.name
    );
    let main = gh_json(root, &endpoint)?;
    let title = json_string(&main, "title").unwrap_or_else(|| "Untitled task".into());
    let state = json_string(&main, "state").unwrap_or_else(|| "unknown".into());
    let url = json_string(&main, "html_url").unwrap_or_default();
    let author = main
        .get("user")
        .and_then(|value| value.get("login"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let updated_at = json_string(&main, "updated_at");
    let body = json_string(&main, "body").unwrap_or_default();
    let labels = json_names(main.get("labels"));
    let assignees = json_users(main.get("assignees"));
    let draft = main.get("draft").and_then(Value::as_bool).unwrap_or(false);
    let merged = main.get("merged").and_then(Value::as_bool).unwrap_or(false)
        || main.get("merged_at").is_some_and(|value| !value.is_null());
    let source_revision = main
        .get("head")
        .and_then(|value| value.get("sha"))
        .and_then(Value::as_str)
        .or_else(|| main.get("sha").and_then(Value::as_str))
        .map(str::to_owned);

    let mut warnings = Vec::new();
    let comments = match gh_json(root, &format!("{endpoint}/comments?per_page=100")) {
        Ok(value) => json_comments(&value),
        Err(error) => {
            warnings.push(format!("comments: {}", error.1));
            Vec::new()
        }
    };
    let reviews = if kind == "pull_request" {
        match gh_json(
            root,
            &format!(
                "repos/{}/{}/pulls/{number}/reviews",
                identity.owner, identity.name
            ),
        ) {
            Ok(value) => json_reviews(&value),
            Err(error) => {
                warnings.push(format!("reviews: {}", error.1));
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let checks = if kind == "pull_request" {
        match source_revision.as_deref() {
            Some(sha) => match gh_json(
                root,
                &format!(
                    "repos/{}/{}/commits/{sha}/check-runs?per_page=100",
                    identity.owner, identity.name
                ),
            ) {
                Ok(value) => json_checks(&value),
                Err(error) => {
                    warnings.push(format!("checks: {}", error.1));
                    Vec::new()
                }
            },
            None => {
                warnings.push("checks: pull request has no source revision".into());
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };
    let id = format!(
        "github:{}/{}/{}:{number}",
        identity.owner, identity.name, kind
    );
    Ok(GithubTaskDetail {
        id,
        kind: kind.into(),
        number,
        title,
        state,
        url,
        author,
        updated_at,
        body,
        draft,
        merged,
        labels,
        assignees,
        comments,
        reviews,
        checks,
        source_revision,
        repository: repository.clone(),
        partial: !warnings.is_empty(),
        warnings,
    })
}

fn normalize_github_kind(kind: &str) -> Option<&'static str> {
    match kind {
        "issue" | "issues" => Some("issue"),
        "pull" | "pull_request" | "pulls" | "pr" => Some("pull_request"),
        _ => None,
    }
}

fn gh_json(root: &str, endpoint: &str) -> Result<Value, (&'static str, String)> {
    let output = gh_api(root, &[endpoint])?;
    parse_json(&output)
}

fn json_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn json_names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .or_else(|| json_string(item, "name"))
                })
                .take(MAX_ITEMS)
                .collect()
        })
        .unwrap_or_default()
}

fn json_users(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    json_string(item, "login").or_else(|| json_string(item, "username"))
                })
                .take(MAX_ITEMS)
                .collect()
        })
        .unwrap_or_default()
}

fn json_comments(value: &Value) -> Vec<GithubTaskComment> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .take(MAX_ITEMS)
                .filter_map(|item| {
                    Some(GithubTaskComment {
                        id: item.get("id")?.to_string().trim_matches('"').to_owned(),
                        author: item
                            .get("user")
                            .and_then(|value| value.get("login"))
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        body: json_string(item, "body").unwrap_or_default(),
                        created_at: json_string(item, "created_at"),
                        url: json_string(item, "html_url"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn json_reviews(value: &Value) -> Vec<GithubTaskReview> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .take(MAX_ITEMS)
                .filter_map(|item| {
                    Some(GithubTaskReview {
                        id: item.get("id")?.to_string().trim_matches('"').to_owned(),
                        author: item
                            .get("user")
                            .and_then(|value| value.get("login"))
                            .map(|value| value.as_str().unwrap_or_default().to_owned()),
                        state: json_string(item, "state").unwrap_or_else(|| "unknown".into()),
                        body: json_string(item, "body").unwrap_or_default(),
                        submitted_at: json_string(item, "submitted_at"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn json_checks(value: &Value) -> Vec<GithubTaskCheck> {
    value
        .get("check_runs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_ITEMS)
                .filter_map(|item| {
                    Some(GithubTaskCheck {
                        name: json_string(item, "name")?,
                        state: json_string(item, "conclusion")
                            .or_else(|| json_string(item, "status"))
                            .unwrap_or_else(|| "unknown".into()),
                        url: json_string(item, "html_url")
                            .or_else(|| json_string(item, "details_url")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn mutate_github_task_blocking(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
    mut request: GithubTaskMutationRequest,
) -> GithubTaskMutationOutcome {
    let (root, repository, identity) = match resolve_github_checkout(paths, project_id) {
        Ok(value) => value,
        Err(error) => return GithubTaskMutationOutcome::failed(error.0, error.1),
    };
    let is_create = matches!(
        request.operation.as_str(),
        "create_issue" | "create_pull_request"
    );
    if request.number == 0 && !is_create {
        return GithubTaskMutationOutcome::failed(
            "invalid_task",
            "Task number must be greater than zero".into(),
        );
    }
    let normalized_kind = match normalize_github_kind(&request.kind) {
        Some(kind) => kind,
        None if request.operation.starts_with("project") => "project",
        None => {
            return GithubTaskMutationOutcome::failed(
                "invalid_kind",
                "kind must be issue, pull_request, or project".into(),
            )
        }
    };
    if let Some(expected) = request.expected_revision.as_deref() {
        if normalized_kind == "project" {
            return GithubTaskMutationOutcome::failed(
                "invalid_revision",
                "Project mutations do not accept task revisions".into(),
            );
        }
        match fetch_github_detail(
            &root,
            &identity,
            &repository,
            normalized_kind,
            request.number,
        ) {
            Ok(detail) if detail.source_revision.as_deref() == Some(expected) => {}
            Ok(_) => {
                return GithubTaskMutationOutcome::failed(
                    "conflict",
                    "The task changed on the provider; refresh before writing".into(),
                )
            }
            Err(error) => return GithubTaskMutationOutcome::failed(error.0, error.1),
        }
    }
    let created_number = match execute_github_mutation(&root, &identity, &request, normalized_kind)
    {
        Ok(number) => number,
        Err(failure) => {
            return match failure {
                GithubMutationFailure::Failed(code, message) => {
                    GithubTaskMutationOutcome::failed(code, message)
                }
                GithubMutationFailure::Unknown(code, message) => {
                    GithubTaskMutationOutcome::unknown(code, message)
                }
            };
        }
    };
    if let Some(number) = created_number {
        request.number = number;
    }
    if normalized_kind == "project" {
        return match fetch_projects(&root, &identity) {
            Ok(_) => GithubTaskMutationOutcome::succeeded(None),
            Err(error) => GithubTaskMutationOutcome::unknown("github_readback_failed", error.1),
        };
    }
    match fetch_github_detail(
        &root,
        &identity,
        &repository,
        normalized_kind,
        request.number,
    ) {
        Ok(detail) if github_mutation_matches(&detail, &request) => {
            GithubTaskMutationOutcome::succeeded(Some(detail))
        }
        Ok(_) => GithubTaskMutationOutcome::unknown(
            "github_readback_mismatch",
            "GitHub accepted the write but the requested state was not observed on read-back"
                .into(),
        ),
        Err(error) => GithubTaskMutationOutcome::unknown("github_readback_failed", error.1),
    }
}

#[derive(Debug)]
enum GithubMutationFailure {
    Failed(&'static str, String),
    Unknown(&'static str, String),
}

fn execute_github_mutation(
    root: &str,
    identity: &RemoteIdentity,
    request: &GithubTaskMutationRequest,
    kind: &str,
) -> Result<Option<u64>, GithubMutationFailure> {
    let is_project = kind == "project" || request.operation.starts_with("project");
    if is_project {
        execute_github_project_mutation(root, request)?;
        return Ok(None);
    }
    let segment = if kind == "pull_request" {
        "pulls"
    } else {
        "issues"
    };
    let endpoint = format!(
        "repos/{}/{}/{segment}/{}",
        identity.owner, identity.name, request.number
    );
    let mut args = Vec::new();
    match request.operation.as_str() {
        "create_issue" => {
            if kind != "issue" {
                return Err(GithubMutationFailure::Failed(
                    "unsupported_operation",
                    "Issue creation requires kind=issue".into(),
                ));
            }
            let title = required_title(request)?;
            args = vec![
                "--method".into(),
                "POST".into(),
                format!("repos/{}/{}/issues", identity.owner, identity.name),
                "--field".into(),
                format!("title={title}"),
            ];
            if let Some(body) = request
                .body
                .as_deref()
                .filter(|body| !body.trim().is_empty())
            {
                validate_body(body)?;
                args.extend(["--field".into(), format!("body={body}")]);
            }
            append_github_list_fields(&mut args, "labels", request.labels.as_deref(), false)?;
            append_github_list_fields(&mut args, "assignees", request.assignees.as_deref(), true)?;
        }
        "create_pull_request" => {
            if kind != "pull_request" {
                return Err(GithubMutationFailure::Failed(
                    "unsupported_operation",
                    "Pull request creation requires kind=pull_request".into(),
                ));
            }
            let title = required_title(request)?;
            let head = required_branch(request.head.as_deref(), "head")?;
            let base = required_branch(request.base.as_deref(), "base")?;
            args = vec![
                "--method".into(),
                "POST".into(),
                format!("repos/{}/{}/pulls", identity.owner, identity.name),
                "--field".into(),
                format!("title={title}"),
                "--field".into(),
                format!("head={head}"),
                "--field".into(),
                format!("base={base}"),
            ];
            if let Some(body) = request
                .body
                .as_deref()
                .filter(|body| !body.trim().is_empty())
            {
                validate_body(body)?;
                args.extend(["--field".into(), format!("body={body}")]);
            }
            if let Some(draft) = request.draft {
                args.extend(["--field".into(), format!("draft={draft}")]);
            }
        }
        "comment" => {
            let body = required_body(request)?;
            args = vec![
                "--method".into(),
                "POST".into(),
                format!("{endpoint}/comments"),
                "--field".into(),
                format!("body={body}"),
            ];
        }
        "status" | "state" => {
            let state = request.state.as_deref().ok_or_else(|| {
                GithubMutationFailure::Failed("invalid_mutation", "state is required".into())
            })?;
            if !matches!(state, "open" | "closed") {
                return Err(GithubMutationFailure::Failed(
                    "invalid_mutation",
                    "state must be open or closed".into(),
                ));
            }
            args = vec![
                "--method".into(),
                "PATCH".into(),
                endpoint.clone(),
                "--field".into(),
                format!("state={state}"),
            ];
        }
        "labels" => {
            let labels = request.labels.as_deref().ok_or_else(|| {
                GithubMutationFailure::Failed("invalid_mutation", "labels is required".into())
            })?;
            args = vec!["--method".into(), "PATCH".into(), endpoint.clone()];
            if labels.is_empty() {
                args.extend(["--field".into(), "labels[]=".into()]);
            } else {
                for label in labels.iter().take(MAX_ITEMS) {
                    if label.trim().is_empty() || label.chars().count() > 100 {
                        return Err(GithubMutationFailure::Failed(
                            "invalid_mutation",
                            "labels must be non-empty and at most 100 characters".into(),
                        ));
                    }
                    args.extend(["--field".into(), format!("labels[]={label}")]);
                }
            }
        }
        "assignees" => {
            let assignees = request.assignees.as_deref().ok_or_else(|| {
                GithubMutationFailure::Failed("invalid_mutation", "assignees is required".into())
            })?;
            args = vec!["--method".into(), "PATCH".into(), endpoint.clone()];
            if assignees.is_empty() {
                args.extend(["--field".into(), "assignees[]=".into()]);
            } else {
                for assignee in assignees.iter().take(MAX_ITEMS) {
                    if !valid_login(assignee) {
                        return Err(GithubMutationFailure::Failed(
                            "invalid_mutation",
                            "assignees must be valid GitHub logins".into(),
                        ));
                    }
                    args.extend(["--field".into(), format!("assignees[]={assignee}")]);
                }
            }
        }
        "review" => {
            if kind != "pull_request" {
                return Err(GithubMutationFailure::Failed(
                    "unsupported_operation",
                    "Reviews are available only for pull requests".into(),
                ));
            }
            let event = request
                .review_event
                .as_deref()
                .unwrap_or("COMMENT")
                .to_ascii_uppercase();
            if !matches!(event.as_str(), "APPROVE" | "REQUEST_CHANGES" | "COMMENT") {
                return Err(GithubMutationFailure::Failed(
                    "invalid_mutation",
                    "review event must be APPROVE, REQUEST_CHANGES, or COMMENT".into(),
                ));
            }
            let body = request.body.clone().unwrap_or_default();
            args = vec![
                "--method".into(),
                "POST".into(),
                format!("{endpoint}/reviews"),
                "--field".into(),
                format!("event={event}"),
                "--field".into(),
                format!("body={body}"),
            ];
        }
        "merge" => {
            if kind != "pull_request" {
                return Err(GithubMutationFailure::Failed(
                    "unsupported_operation",
                    "Only pull requests can be merged".into(),
                ));
            }
            let method = request
                .merge_method
                .as_deref()
                .unwrap_or("merge")
                .to_ascii_lowercase();
            if !matches!(method.as_str(), "merge" | "squash" | "rebase") {
                return Err(GithubMutationFailure::Failed(
                    "invalid_mutation",
                    "merge method must be merge, squash, or rebase".into(),
                ));
            }
            args = vec![
                "--method".into(),
                "PUT".into(),
                format!("{endpoint}/merge"),
                "--field".into(),
                format!("merge_method={method}"),
            ];
        }
        _ => {
            return Err(GithubMutationFailure::Failed(
                "unsupported_operation",
                "Unsupported GitHub task mutation".into(),
            ))
        }
    }
    let response = gh_write(root, args)?;
    if request.operation == "create_issue" || request.operation == "create_pull_request" {
        let number = response
            .get("number")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                GithubMutationFailure::Unknown(
                    "github_create_unknown",
                    "GitHub accepted creation but did not return a task number".into(),
                )
            })?;
        Ok(Some(number))
    } else {
        Ok(None)
    }
}

fn execute_github_project_mutation(
    root: &str,
    request: &GithubTaskMutationRequest,
) -> Result<(), GithubMutationFailure> {
    let project_id = request
        .project_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            GithubMutationFailure::Failed(
                "invalid_mutation",
                "project_id is required for Project writes".into(),
            )
        })?;
    let (query, mut args) = if request.operation == "project_update" {
        let title = request
            .body
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                GithubMutationFailure::Failed(
                    "invalid_mutation",
                    "body contains the Project title and is required".into(),
                )
            })?;
        ("mutation($projectId:ID!,$title:String!){updateProjectV2(input:{projectId:$projectId,title:$title}){projectV2{id}}}".to_owned(), vec![("projectId", project_id.to_owned()), ("title", title.to_owned())])
    } else if request.operation == "project_item_update" {
        let item_id = request
            .item_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                GithubMutationFailure::Failed(
                    "invalid_mutation",
                    "item_id is required for Project item writes".into(),
                )
            })?;
        let field_id = request
            .field_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                GithubMutationFailure::Failed(
                    "invalid_mutation",
                    "field_id is required for Project item writes".into(),
                )
            })?;
        let value = request.field_value.as_deref().ok_or_else(|| {
            GithubMutationFailure::Failed(
                "invalid_mutation",
                "field_value is required for Project item writes".into(),
            )
        })?;
        ("mutation($projectId:ID!,$itemId:ID!,$fieldId:ID!,$value:String!){updateProjectV2ItemFieldValue(input:{projectId:$projectId,itemId:$itemId,fieldId:$fieldId,value:{text:$value}}){projectV2Item{id}}}".to_owned(), vec![("projectId", project_id.to_owned()), ("itemId", item_id.to_owned()), ("fieldId", field_id.to_owned()), ("value", value.to_owned())])
    } else {
        return Err(GithubMutationFailure::Failed(
            "unsupported_operation",
            "Unsupported GitHub Project mutation".into(),
        ));
    };
    args.insert(0, ("query", query));
    let mut command = vec!["graphql".to_owned()];
    for (key, value) in args {
        command.extend(["--field".to_owned(), format!("{key}={value}")]);
    }
    gh_write(root, command).map(|_| ())
}

fn required_body(request: &GithubTaskMutationRequest) -> Result<String, GithubMutationFailure> {
    let body = request
        .body
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            GithubMutationFailure::Failed("invalid_mutation", "body is required".into())
        })?;
    validate_body(&body)?;
    Ok(body)
}

fn validate_body(body: &str) -> Result<(), GithubMutationFailure> {
    if body.chars().count() > 20_000 {
        return Err(GithubMutationFailure::Failed(
            "invalid_mutation",
            "body is limited to 20,000 characters".into(),
        ));
    }
    Ok(())
}

fn required_title(request: &GithubTaskMutationRequest) -> Result<String, GithubMutationFailure> {
    let title = request
        .title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            GithubMutationFailure::Failed("invalid_mutation", "title is required".into())
        })?;
    if title.chars().count() > 256 {
        return Err(GithubMutationFailure::Failed(
            "invalid_mutation",
            "title is limited to 256 characters".into(),
        ));
    }
    Ok(title)
}

fn required_branch(value: Option<&str>, name: &str) -> Result<String, GithubMutationFailure> {
    let branch = value
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            GithubMutationFailure::Failed("invalid_mutation", format!("{name} is required"))
        })?;
    if branch.chars().count() > 512 || branch.chars().any(|character| character.is_control()) {
        return Err(GithubMutationFailure::Failed(
            "invalid_mutation",
            format!("{name} is invalid or too long"),
        ));
    }
    Ok(branch.to_owned())
}

fn append_github_list_fields(
    args: &mut Vec<String>,
    field: &str,
    values: Option<&[String]>,
    logins: bool,
) -> Result<(), GithubMutationFailure> {
    let Some(values) = values else {
        return Ok(());
    };
    for value in values.iter().take(MAX_ITEMS) {
        if logins {
            if !valid_login(value) {
                return Err(GithubMutationFailure::Failed(
                    "invalid_mutation",
                    "assignees must be valid GitHub logins".into(),
                ));
            }
        } else if value.trim().is_empty() || value.chars().count() > 100 {
            return Err(GithubMutationFailure::Failed(
                "invalid_mutation",
                "labels must be non-empty and at most 100 characters".into(),
            ));
        }
        args.extend(["--field".into(), format!("{field}[]={value}")]);
    }
    Ok(())
}

fn valid_login(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 39
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn github_mutation_matches(detail: &GithubTaskDetail, request: &GithubTaskMutationRequest) -> bool {
    match request.operation.as_str() {
        "status" | "state" => request
            .state
            .as_deref()
            .is_some_and(|state| detail.state.eq_ignore_ascii_case(state)),
        "labels" => request
            .labels
            .as_ref()
            .is_some_and(|labels| detail.labels == *labels),
        "assignees" => request
            .assignees
            .as_ref()
            .is_some_and(|assignees| detail.assignees == *assignees),
        "merge" => detail.merged || detail.state.eq_ignore_ascii_case("merged"),
        "comment" => request
            .body
            .as_ref()
            .is_some_and(|body| detail.comments.iter().any(|comment| comment.body == *body)),
        "review" => request
            .body
            .as_ref()
            .is_none_or(|body| detail.reviews.iter().any(|review| review.body == *body)),
        _ => true,
    }
}

fn load_github_task_options(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
) -> Result<TaskOptionsEnvelope, (&'static str, String)> {
    let (root, _repository, identity) = resolve_github_checkout(paths, project_id)?;
    let labels = parse_json::<Vec<Value>>(&gh_api(
        &root,
        &[&format!("repos/{}/{}/labels?per_page=100", identity.owner, identity.name)],
    )?)
    .map_err(|error| (error.0, error.1))?
    .into_iter()
    .filter_map(|value| json_string(&value, "name"))
    .take(MAX_ITEMS)
    .collect();
    let assignees = parse_json::<Vec<Value>>(&gh_api(
        &root,
        &[&format!("repos/{}/{}/assignees?per_page=100", identity.owner, identity.name)],
    )?)
    .map_err(|error| (error.0, error.1))?
    .into_iter()
    .filter_map(|value| {
        let login = json_string(&value, "login")?;
        Some(TaskOption {
            id: login.clone(),
            name: login,
        })
    })
    .take(MAX_ITEMS)
    .collect();
    Ok(TaskOptionsEnvelope {
        labels,
        assignees,
        error: None,
    })
}

fn upload_github_task_image_blocking(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
    file_name: &str,
    content_type: &str,
    content_base64: &str,
) -> Result<String, (&'static str, String)> {
    let (root, _repository, identity) = resolve_github_checkout(paths, project_id)?;
    let normalized_content_type = content_type.trim().to_ascii_lowercase();
    if !matches!(
        normalized_content_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err((
            "invalid_image",
            "Only PNG, JPEG, GIF, and WebP images are supported".into(),
        ));
    }
    let content_type = normalized_content_type.as_str();
    if content_base64.len() > (MAX_IMAGE_BYTES.div_ceil(3) * 4 + 4) {
        return Err(("invalid_image", "Image data exceeds the 10 MiB limit".into()));
    }
    let bytes = BASE64
        .decode(content_base64)
        .map_err(|_| ("invalid_image", "Image data is not valid base64".into()))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err((
            "invalid_image",
            "Image must be between 1 byte and 10 MiB".into(),
        ));
    }
    if !image_signature_matches(content_type, &bytes) {
        return Err((
            "invalid_image",
            "Image bytes do not match the declared PNG, JPEG, GIF, or WebP type".into(),
        ));
    }
    let safe_name = sanitize_upload_file_name(file_name);
    let repository = gh_api(
        &root,
        &[&format!("repos/{}/{}", identity.owner, identity.name)],
    )
    .map_err(|error| (error.0, error.1))?;
    let repository_id = parse_json::<Value>(&repository)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_u64))
        .ok_or((
            "github_upload_failed",
            "GitHub did not return a repository id for image upload".into(),
        ))?;
    let endpoint = format!(
        "https://uploads.github.com/user-attachments/assets?name={}&content_type={}&repository_id={repository_id}",
        percent_encode_query_component(&safe_name),
        percent_encode_query_component(content_type),
    );
    let args = vec![
        "api".into(),
        "-X".into(),
        "POST".into(),
        endpoint,
        "-H".into(),
        "Content-Type: application/octet-stream".into(),
        "-H".into(),
        format!("Content-Length: {}", bytes.len()),
        "--input".into(),
        "-".into(),
    ];
    let output = run_command_with_input("gh", &args, Some(&root), &bytes)
        .map_err(|message| ("github_upload_unknown", message))?;
    if !output.success {
        return Err((
            "github_upload_failed",
            truncate_message(text_output(&output.stderr)),
        ));
    }
    let url = parse_json::<Value>(&output.stdout)
        .ok()
        .and_then(|value| value.get("url").and_then(Value::as_str).map(str::to_owned))
        .filter(|url| url.starts_with("https://github.com/user-attachments/"))
        .ok_or((
            "github_upload_failed",
            "GitHub did not return a safe image URL".into(),
        ))?;
    Ok(url)
}

fn image_signature_matches(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

fn sanitize_upload_file_name(file_name: &str) -> String {
    let raw = Path::new(file_name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("image.png");
    let mut name: String = raw
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    if name.is_empty() {
        name = "image.png".into();
    }
    name
}

fn percent_encode_query_component(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn gh_write(root: &str, args: Vec<String>) -> Result<Value, GithubMutationFailure> {
    let mut command_args = vec![
        "api".to_owned(),
        "--hostname".to_owned(),
        "github.com".to_owned(),
    ];
    command_args.extend(args);
    let output = match run_command("gh", command_args, Some(root)) {
        Ok(output) => output,
        Err(error) if error.contains("timed out") => {
            return Err(GithubMutationFailure::Unknown(
                "github_write_unknown",
                error,
            ))
        }
        Err(error) if error.contains("not available") => {
            return Err(GithubMutationFailure::Failed("gh_unavailable", error))
        }
        Err(error) => {
            return Err(GithubMutationFailure::Unknown(
                "github_write_unknown",
                error,
            ))
        }
    };
    if output.success {
        return Ok(serde_json::from_slice(&output.stdout).unwrap_or(Value::Null));
    }
    let stderr = text_output(&output.stderr);
    let lower = stderr.to_ascii_lowercase();
    let code = if lower.contains("not logged in")
        || lower.contains("authentication")
        || lower.contains("auth")
    {
        "github_auth_required"
    } else if lower.contains("rate limit") {
        "github_rate_limited"
    } else if lower.contains("forbidden") || lower.contains("permission") {
        "github_forbidden"
    } else {
        "github_write_failed"
    };
    Err(GithubMutationFailure::Failed(
        code,
        truncate_message(stderr),
    ))
}

fn run_command_with_input(
    program: &str,
    args: &[String],
    current_dir: Option<&str>,
    input: &[u8],
) -> Result<CommandOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    let mut child = command
        .spawn()
        .map_err(|_| format!("{program} is not available"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|_| format!("{program} input could not be written"))?;
    }
    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|_| format!("{program} failed while running"))?
        {
            Some(status) => {
                let output = child
                    .wait_with_output()
                    .map_err(|_| format!("{program} output could not be read"))?;
                return Ok(CommandOutput {
                    success: status.success(),
                    stdout: output.stdout,
                    stderr: output.stderr,
                });
            }
            None if started.elapsed() >= COMMAND_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} timed out"));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn git_root(checkout: &str) -> Result<String, (&'static str, String)> {
    let output = run_command(
        "git",
        ["-C", checkout, "rev-parse", "--show-toplevel"],
        None,
    )
    .map_err(|message| ("git_unavailable", message))?;
    if !output.success {
        return Err((
            "not_git_repository",
            "The AgentPort project is not a Git checkout".into(),
        ));
    }
    let root = text_output(&output.stdout);
    if root.is_empty() || !Path::new(&root).is_dir() {
        return Err((
            "invalid_git_root",
            "Git returned an invalid checkout root".into(),
        ));
    }
    Ok(root)
}

fn github_remote(root: &str) -> Result<(RemoteIdentity, String), (&'static str, String)> {
    let remote = resolve_main_remote(root).map_err(|message| {
        (
            "github_remote_required",
            format!("The origin/main upstream has no supported github.com remote: {message}"),
        )
    })?;
    let identity = parse_github_remote(&remote.canonical_url()).ok_or((
        "github_remote_required",
        "The origin/main upstream is not a supported github.com repository".into(),
    ))?;
    Ok((identity, remote.canonical_url()))
}

fn detect_task_provider_blocking(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
) -> TaskProviderDetection {
    let db = match Db::open_read(paths) {
        Ok(db) => db,
        Err(error) => {
            return TaskProviderDetection::failed("project_read_failed", error.to_string())
        }
    };
    let project = match db.get_project(project_id) {
        Ok(project) => project,
        Err(error) => return TaskProviderDetection::failed("project_not_found", error.to_string()),
    };
    let checkout = project
        .git_root_path
        .as_deref()
        .unwrap_or(&project.root_path);
    let root = match git_root(checkout) {
        Ok(root) => root,
        Err(error) => return TaskProviderDetection::failed(error.0, error.1),
    };
    let remote = match resolve_main_remote(&root) {
        Ok(remote) => remote,
        Err(error) => return TaskProviderDetection::failed("remote_unavailable", error),
    };
    let provider = match provider_for_remote(&remote) {
        Some(provider) => provider,
        None => {
            let canonical_url = remote.canonical_url();
            let host = remote.host.clone();
            let path = remote.path.clone();
            let mut detection = TaskProviderDetection::failed(
                "unsupported_provider",
                format!("No supported task provider is recognized for origin/main host {host}"),
            );
            detection.host = Some(host);
            detection.remote_url = Some(canonical_url);
            detection.repository = Some(path);
            return detection;
        }
    };
    let project_path = match provider {
        TaskProvider::Github => remote.path.clone(),
        TaskProvider::Gitlab => gitlab_project_path(&remote),
    };
    let valid_repository = match provider {
        TaskProvider::Github => github_repository(&project_path).is_some(),
        TaskProvider::Gitlab => is_valid_project_path(&project_path),
    };
    if !valid_repository {
        let canonical_url = remote.canonical_url();
        let host = remote.host.clone();
        let message = match provider {
            TaskProvider::Github => {
                "The origin/main remote is not a valid GitHub owner/repository path"
            }
            TaskProvider::Gitlab => {
                "The origin/main remote is not a valid GitLab namespace/project path"
            }
        };
        let mut detection = TaskProviderDetection::failed("invalid_repository", message);
        detection.host = Some(host);
        detection.remote_url = Some(canonical_url);
        detection.repository = Some(project_path);
        return detection;
    }
    let canonical_url = remote.canonical_url();
    TaskProviderDetection {
        provider: Some(provider.as_str().into()),
        host: Some(remote.host),
        remote_url: Some(canonical_url),
        repository: Some(project_path),
        error_code: None,
        error: None,
    }
}

fn fetch_issues(
    root: &str,
    identity: &RemoteIdentity,
) -> Result<GithubTaskData, (&'static str, String)> {
    let endpoint = format!(
        "repos/{}/{}/issues?state=all&per_page={MAX_ITEMS}&sort=updated&direction=desc",
        identity.owner, identity.name
    );
    let output = gh_api(
        root,
        &[
            &endpoint,
            "--jq",
            "[.[] | {number,title,state,html_url,user,updated_at,labels,pull_request}]",
        ],
    )?;
    let entries: Vec<IssueApi> = parse_json(&output)?;
    let issues = entries
        .into_iter()
        .filter(|entry| entry.pull_request.is_none())
        .map(|entry| GithubIssue {
            number: entry.number,
            title: entry.title,
            state: entry.state,
            url: entry.html_url,
            author: entry.user.map(|user| user.login),
            updated_at: entry.updated_at,
            labels: entry.labels.into_iter().map(|label| label.name).collect(),
            assignees: entry.assignees.into_iter().map(|user| user.login).collect(),
        })
        .collect();
    Ok(GithubTaskData::Issues(issues))
}

fn fetch_pulls(
    root: &str,
    identity: &RemoteIdentity,
) -> Result<GithubTaskData, (&'static str, String)> {
    let endpoint = format!(
        "repos/{}/{}/pulls?state=all&per_page={MAX_ITEMS}&sort=updated&direction=desc",
        identity.owner, identity.name
    );
    let output = gh_api(
        root,
        &[
            &endpoint,
            "--jq",
            "[.[] | {number,title,state,html_url,user,updated_at,draft}]",
        ],
    )?;
    let entries: Vec<PullApi> = parse_json(&output)?;
    Ok(GithubTaskData::Pulls(
        entries
            .into_iter()
            .map(|entry| GithubPullRequest {
                number: entry.number,
                title: entry.title,
                state: entry.state,
                url: entry.html_url,
                author: entry.user.map(|user| user.login),
                updated_at: entry.updated_at,
                draft: entry.draft,
                labels: entry.labels.into_iter().map(|label| label.name).collect(),
                assignees: entry.assignees.into_iter().map(|user| user.login).collect(),
            })
            .collect(),
    ))
}

fn fetch_projects(
    root: &str,
    identity: &RemoteIdentity,
) -> Result<GithubTaskData, (&'static str, String)> {
    // Projects V2 is GraphQL-only. Keep both the query and result bounded so a
    // repository with many projects cannot turn refresh into an unbounded read.
    let query = "query($owner:String!, $repo:String!) { repository(owner:$owner, name:$repo) { projectsV2(first:20, orderBy:{field:UPDATED_AT, direction:DESC}) { nodes { number title url shortDescription updatedAt closed } } } }";
    let output = gh_api(
        root,
        &[
            "graphql",
            "-f",
            &format!("query={query}"),
            "-f",
            &format!("owner={}", identity.owner),
            "-f",
            &format!("repo={}", identity.name),
        ],
    )?;
    let response: GraphQlResponse = parse_json(&output)?;
    if let Some(errors) = response.errors.filter(|errors| !errors.is_empty()) {
        let message = errors
            .into_iter()
            .find_map(|error| error.message)
            .unwrap_or_else(|| "GitHub Projects could not be read".into());
        return Err(("github_projects_failed", truncate_message(message)));
    }
    let projects = response
        .data
        .and_then(|data| data.repository)
        .ok_or((
            "github_projects_failed",
            "GitHub returned no Projects data".into(),
        ))?
        .projects
        .nodes
        .into_iter()
        .flatten()
        .map(|project| GithubProject {
            number: project.number,
            title: project.title,
            url: project.url,
            short_description: project.short_description,
            updated_at: project.updated_at,
            closed: project.closed,
        })
        .collect();
    Ok(GithubTaskData::Projects(projects))
}

fn gh_api(root: &str, args: &[&str]) -> Result<Vec<u8>, (&'static str, String)> {
    let mut command_args = vec!["api", "--hostname", "github.com"];
    command_args.extend_from_slice(args);
    let output = run_command("gh", command_args, Some(root))
        .map_err(|message| ("gh_unavailable", message))?;
    if !output.success {
        let stderr = text_output(&output.stderr).to_ascii_lowercase();
        let code = if stderr.contains("not logged in") || stderr.contains("authentication") {
            "github_auth_required"
        } else {
            "github_request_failed"
        };
        return Err((
            code,
            "GitHub CLI could not complete the read request".into(),
        ));
    }
    Ok(output.stdout)
}

fn parse_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, (&'static str, String)> {
    serde_json::from_slice(bytes).map_err(|_| {
        (
            "github_invalid_response",
            "GitHub returned an invalid response".into(),
        )
    })
}

fn run_command<I, S>(
    program: &str,
    args: I,
    current_dir: Option<&str>,
) -> Result<CommandOutput, String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(current_dir) = current_dir {
        command.current_dir(current_dir);
    }
    let mut child = command
        .spawn()
        .map_err(|_| format!("{program} is not available"))?;
    let started = Instant::now();
    loop {
        match child
            .try_wait()
            .map_err(|_| format!("{program} failed while running"))?
        {
            Some(status) => {
                let output = child
                    .wait_with_output()
                    .map_err(|_| format!("{program} output could not be read"))?;
                return Ok(CommandOutput {
                    success: status.success(),
                    stdout: output.stdout,
                    stderr: output.stderr,
                });
            }
            None if started.elapsed() >= COMMAND_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} timed out"));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

fn text_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_owned()
}

fn truncate_message(message: String) -> String {
    message.chars().take(240).collect()
}

/// Parse only GitHub's public repository URL forms; credentials and arbitrary
/// hosts never enter the returned identity.
fn parse_github_remote(remote: &str) -> Option<RemoteIdentity> {
    let remote = parse_remote(remote)?;
    if !remote.host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let (owner, name) = github_repository(&remote.path)?;
    if owner.len() > 100 || name.len() > 100 {
        return None;
    }
    Some(RemoteIdentity { owner, name })
}

impl GithubTaskDetailEnvelope {
    fn error(code: &str, message: String) -> Self {
        Self {
            repository: None,
            capabilities: github_capabilities(),
            data: None,
            error: Some(GithubTaskError {
                code: code.into(),
                message,
            }),
        }
    }
}

impl GithubTaskMutationOutcome {
    fn succeeded(data: Option<GithubTaskDetail>) -> Self {
        Self {
            status: "succeeded".into(),
            data,
            error: None,
            read_back_required: false,
        }
    }

    fn failed(code: &'static str, message: String) -> Self {
        Self {
            status: "failed".into(),
            data: None,
            error: Some(GithubTaskError {
                code: code.into(),
                message,
            }),
            read_back_required: false,
        }
    }

    fn unknown(code: &'static str, message: String) -> Self {
        Self {
            status: "unknown".into(),
            data: None,
            error: Some(GithubTaskError {
                code: code.into(),
                message,
            }),
            read_back_required: true,
        }
    }
}

impl GithubTaskEnvelope {
    fn empty(scope: &str) -> Self {
        Self {
            scope: scope.to_owned(),
            repository: None,
            capabilities: github_capabilities(),
            data: None,
            error: None,
        }
    }

    fn error(scope: &str, code: &str, message: String) -> Self {
        Self {
            scope: scope.to_owned(),
            repository: None,
            capabilities: github_capabilities(),
            data: None,
            error: Some(GithubTaskError {
                code: code.into(),
                message,
            }),
        }
    }

    fn with_error(mut self, code: &'static str, message: String) -> Self {
        self.error = Some(GithubTaskError {
            code: code.into(),
            message,
        });
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_github_remote_forms() {
        let expected = RemoteIdentity {
            owner: "octo-org".into(),
            name: "repo_name".into(),
        };
        assert_eq!(
            parse_github_remote("https://github.com/octo-org/repo_name.git"),
            Some(expected.clone())
        );
        assert_eq!(
            parse_github_remote("git@github.com:octo-org/repo_name.git"),
            Some(expected.clone())
        );
        assert_eq!(
            parse_github_remote("ssh://git@github.com/octo-org/repo_name"),
            Some(expected)
        );
    }

    #[test]
    fn rejects_non_github_and_ambiguous_urls() {
        assert_eq!(parse_github_remote("https://gitlab.com/o/r.git"), None);
        assert_eq!(parse_github_remote("https://github.com/o/r/issues"), None);
        assert_eq!(parse_github_remote("file:///tmp/repo"), None);
    }

    #[test]
    fn validates_image_signatures() {
        assert!(image_signature_matches("image/png", b"\x89PNG\r\n\x1a\nrest"));
        assert!(image_signature_matches("image/jpeg", &[0xff, 0xd8, 0xff, 0xe0]));
        assert!(image_signature_matches("image/gif", b"GIF89a"));
        assert!(image_signature_matches("image/webp", b"RIFFxxxxWEBP"));
        assert!(!image_signature_matches("image/png", b"GIF89a"));
    }

    #[test]
    fn validates_create_fields() {
        let request = GithubTaskMutationRequest {
            title: Some("New task".into()),
            ..Default::default()
        };
        assert_eq!(required_title(&request).unwrap(), "New task");
        assert!(required_title(&GithubTaskMutationRequest::default()).is_err());
        assert!(required_branch(Some(""), "head").is_err());
        assert!(validate_body(&"x".repeat(20_001)).is_err());
    }

    #[test]
    fn normalizes_issue_pull_request_entries() {
        let json = br#"[{"number":1,"title":"issue","state":"open","html_url":"https://github.com/o/r/issues/1","user":{"login":"octo"},"updated_at":null,"labels":[],"pull_request":null}]"#;
        let entries: Vec<IssueApi> = parse_json(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].pull_request.is_none());
    }
}
