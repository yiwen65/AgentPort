//! Read-only GitLab task discovery. Credentials stay in the device-local glab
//! configuration; no token is read into AgentPort memory or serialized.

use agentport_core::db::Db;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

use crate::AppState;
use agentport_core::task_remote::{
    gitlab_project_path, is_valid_project_path, parse_remote, provider_for_remote,
    resolve_main_remote, TaskProvider, TaskRemote,
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_ITEMS: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskRepository {
    pub host: String,
    pub namespace: String,
    pub name: String,
    pub remote_url: String,
    pub project_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskEnvelope {
    pub scope: String,
    pub repository: Option<GitlabTaskRepository>,
    pub capabilities: GitlabTaskCapabilities,
    pub items: Vec<Value>,
    pub error: Option<GitlabTaskError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskCapabilities {
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

fn gitlab_capabilities() -> GitlabTaskCapabilities {
    GitlabTaskCapabilities {
        comments: true,
        status: true,
        labels: true,
        assignees: true,
        reviews: true,
        checks: true,
        projects: false,
        project_writes: true,
        merge: true,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskComment {
    pub id: String,
    pub author: Option<String>,
    pub body: String,
    pub created_at: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskReview {
    pub id: String,
    pub author: Option<String>,
    pub state: String,
    pub body: String,
    pub submitted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskCheck {
    pub name: String,
    pub state: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskDetail {
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
    pub comments: Vec<GitlabTaskComment>,
    pub reviews: Vec<GitlabTaskReview>,
    pub checks: Vec<GitlabTaskCheck>,
    pub source_revision: Option<String>,
    pub repository: GitlabTaskRepository,
    pub partial: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitlabTaskMutationRequest {
    pub kind: String,
    pub number: u64,
    pub operation: String,
    pub body: Option<String>,
    pub state: Option<String>,
    pub labels: Option<Vec<String>>,
    pub assignees: Option<Vec<String>>,
    pub review_event: Option<String>,
    pub expected_revision: Option<String>,
    pub board_id: Option<u64>,
    pub list_id: Option<u64>,
    pub position: Option<u64>,
    pub label_id: Option<u64>,
    pub assignee_ids: Option<Vec<u64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskDetailEnvelope {
    pub repository: Option<GitlabTaskRepository>,
    pub capabilities: GitlabTaskCapabilities,
    pub data: Option<GitlabTaskDetail>,
    pub error: Option<GitlabTaskError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitlabTaskMutationOutcome {
    pub status: String,
    pub data: Option<GitlabTaskDetail>,
    pub error: Option<GitlabTaskError>,
    pub read_back_required: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitlabTaskError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone)]
struct RemoteIdentity {
    host: String,
    project_path: String,
    namespace: String,
    name: String,
}

#[tauri::command]
pub async fn list_gitlab_tasks(
    state: State<'_, AppState>,
    project_id: String,
    scope: String,
) -> Result<GitlabTaskEnvelope, String> {
    let paths = state.paths.clone();
    let fallback_scope = scope.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || load_tasks(&paths, &project_id, &scope))
            .await
            .map_err(|error| format!("GitLab task worker failed: {error}"))?;
    Ok(result.unwrap_or_else(|error| GitlabTaskEnvelope::error(&fallback_scope, error.0, error.1)))
}

#[tauri::command]
pub async fn get_gitlab_task(
    state: tauri::State<'_, AppState>,
    project_id: String,
    kind: String,
    number: u64,
) -> Result<GitlabTaskDetailEnvelope, String> {
    let paths = state.paths.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        load_gitlab_detail(&paths, &project_id, &kind, number)
    })
    .await;
    Ok(match result {
        Ok(Ok(envelope)) => envelope,
        Ok(Err(error)) => GitlabTaskDetailEnvelope::error("gitlab_unavailable", error),
        Err(error) => GitlabTaskDetailEnvelope::error("backend_unavailable", error.to_string()),
    })
}

#[tauri::command]
pub async fn mutate_gitlab_task(
    state: tauri::State<'_, AppState>,
    project_id: String,
    request: GitlabTaskMutationRequest,
) -> Result<GitlabTaskMutationOutcome, String> {
    let paths = state.paths.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        mutate_gitlab_task_blocking(&paths, &project_id, request)
    })
    .await;
    Ok(match result {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(error)) => GitlabTaskMutationOutcome::unknown("gitlab_unavailable", error),
        Err(error) => GitlabTaskMutationOutcome::unknown("backend_unavailable", error.to_string()),
    })
}

fn resolve_gitlab_checkout(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
) -> Result<(String, GitlabTaskRepository, RemoteIdentity), String> {
    let db = Db::open_read(paths).map_err(|error| error.to_string())?;
    let project = db
        .get_project(project_id)
        .map_err(|error| error.to_string())?;
    let checkout = project
        .git_root_path
        .as_deref()
        .unwrap_or(&project.root_path);
    let root = command_text(
        "git",
        &["-C", checkout, "rev-parse", "--show-toplevel"],
        None,
    )
    .map_err(|error| format!("not_git_repository: {error}"))?;
    let (identity, remote_url) = gitlab_remote(&root).map_err(|error| error.1)?;
    let repository = GitlabTaskRepository {
        host: identity.host.clone(),
        namespace: identity.namespace.clone(),
        name: identity.name.clone(),
        remote_url,
        project_path: identity.project_path.clone(),
    };
    Ok((root, repository, identity))
}

fn load_gitlab_detail(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
    kind: &str,
    number: u64,
) -> Result<GitlabTaskDetailEnvelope, String> {
    let (root, repository, identity) = resolve_gitlab_checkout(paths, project_id)?;
    let segment = if kind == "merge_request" {
        "merge_requests"
    } else {
        "issues"
    };
    let endpoint = format!(
        "projects/{}/{}/{}",
        encode_path(&identity.project_path),
        segment,
        number
    );
    let value = glab_api(&root, &identity.host, &endpoint)
        .map_err(|error| error.1)?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    let detail = GitlabTaskDetail {
        id: value
            .get("id")
            .and_then(Value::as_u64)
            .map(|id| id.to_string())
            .unwrap_or_else(|| number.to_string()),
        kind: kind.into(),
        number,
        title: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        state: value
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .into(),
        url: value
            .get("web_url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        author: value
            .get("author")
            .and_then(|v| v.get("username"))
            .and_then(Value::as_str)
            .map(str::to_owned),
        updated_at: value
            .get("updated_at")
            .and_then(Value::as_str)
            .map(str::to_owned),
        body: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .into(),
        draft: value.get("draft").and_then(Value::as_bool).unwrap_or(false),
        merged: value.get("merged_at").is_some_and(|v| !v.is_null()),
        labels: value
            .get("labels")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        assignees: value
            .get("assignees")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.get("username").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        comments: glab_api(
            &root,
            &identity.host,
            &format!(
                "projects/{}/{segment}/{number}/notes?per_page=100",
                encode_path(&identity.project_path)
            ),
        )
        .ok()
        .map(|items| {
            items
                .into_iter()
                .map(|v| GitlabTaskComment {
                    id: v
                        .get("id")
                        .and_then(Value::as_u64)
                        .map(|n| n.to_string())
                        .unwrap_or_default(),
                    author: v
                        .get("author")
                        .and_then(|a| a.get("username"))
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    body: v
                        .get("body")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into(),
                    created_at: v
                        .get("created_at")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    url: v
                        .get("noteable_url")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default(),
        reviews: if kind == "merge_request" {
            glab_api(
                &root,
                &identity.host,
                &format!(
                    "projects/{}/merge_requests/{number}/approvals",
                    encode_path(&identity.project_path)
                ),
            )
            .ok()
            .map(|items| {
                items
                    .into_iter()
                    .map(|v| GitlabTaskReview {
                        id: v
                            .get("id")
                            .and_then(Value::as_u64)
                            .map(|n| n.to_string())
                            .unwrap_or_default(),
                        author: None,
                        state: v
                            .get("approved")
                            .and_then(Value::as_bool)
                            .map(|b| if b { "approved" } else { "pending" })
                            .unwrap_or("pending")
                            .into(),
                        body: String::new(),
                        submitted_at: None,
                    })
                    .collect()
            })
            .unwrap_or_default()
        } else {
            Vec::new()
        },
        checks: if kind == "merge_request" {
            glab_api(
                &root,
                &identity.host,
                &format!(
                    "projects/{}/merge_requests/{number}/pipelines",
                    encode_path(&identity.project_path)
                ),
            )
            .ok()
            .map(|items| {
                items
                    .into_iter()
                    .map(|v| GitlabTaskCheck {
                        name: format!(
                            "pipeline-{}",
                            v.get("id").and_then(Value::as_u64).unwrap_or_default()
                        ),
                        state: v
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .into(),
                        url: v.get("web_url").and_then(Value::as_str).map(str::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default()
        } else {
            Vec::new()
        },
        source_revision: value.get("sha").and_then(Value::as_str).map(str::to_owned),
        repository,
        partial: true,
        warnings: vec![
            "Comments, reviews, and checks are loaded on demand by the provider detail view."
                .into(),
        ],
    };
    Ok(GitlabTaskDetailEnvelope {
        repository: Some(detail.repository.clone()),
        capabilities: gitlab_capabilities(),
        data: Some(detail),
        error: None,
    })
}

fn mutate_gitlab_task_blocking(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
    request: GitlabTaskMutationRequest,
) -> Result<GitlabTaskMutationOutcome, String> {
    let (root, _repository, identity) = resolve_gitlab_checkout(paths, project_id)?;
    let number = request.number;
    let request_kind = request.kind.clone();
    let segment = if request_kind == "merge_request" {
        "merge_requests"
    } else {
        "issues"
    };
    let (method, endpoint, field, field_name) = match request.operation.as_str() {
        "comment" => (
            "POST",
            format!(
                "projects/{}/{segment}/{number}/notes",
                encode_path(&identity.project_path)
            ),
            request.body.unwrap_or_default(),
            "body",
        ),
        "state" => (
            "PUT",
            format!(
                "projects/{}/{segment}/{number}",
                encode_path(&identity.project_path)
            ),
            request.state.unwrap_or_else(|| "reopen".into()),
            "state_event",
        ),
        "labels" => (
            "PUT",
            format!(
                "projects/{}/{segment}/{number}",
                encode_path(&identity.project_path)
            ),
            request.labels.unwrap_or_default().join(","),
            "labels",
        ),
        "assignees" => (
            "PUT",
            format!(
                "projects/{}/{segment}/{number}",
                encode_path(&identity.project_path)
            ),
            request
                .assignee_ids
                .unwrap_or_default()
                .iter()
                .map(u64::to_string)
                .collect::<Vec<_>>()
                .join(","),
            "assignee_ids",
        ),
        "merge" => (
            "PUT",
            format!(
                "projects/{}/merge_requests/{number}/merge",
                encode_path(&identity.project_path)
            ),
            String::new(),
            "merge_when_pipeline_succeeds",
        ),
        "board_move" => (
            "PUT",
            format!(
                "projects/{}/boards/{}/lists/{}/issues/{}",
                encode_path(&identity.project_path),
                request.board_id.unwrap_or_default(),
                request.list_id.unwrap_or_default(),
                number
            ),
            request.position.unwrap_or_default().to_string(),
            "position",
        ),
        _ => {
            return Ok(GitlabTaskMutationOutcome::unknown(
                "unsupported_operation",
                "GitLab operation is unsupported".into(),
            ))
        }
    };
    let output = command_output(
        "glab",
        &[
            "api",
            "--hostname",
            &identity.host,
            "-X",
            method,
            &endpoint,
            "--raw-field",
            &format!("{field_name}={field}"),
        ],
        Some(&root),
    )
    .map_err(|error| error.to_string())?;
    if !output.success {
        return Ok(GitlabTaskMutationOutcome::unknown(
            "gitlab_request_failed",
            "GitLab mutation failed; read back required".into(),
        ));
    }
    match load_gitlab_detail(paths, project_id, &request_kind, number) {
        Ok(detail) if detail.error.is_none() => Ok(GitlabTaskMutationOutcome {
            status: "succeeded".into(),
            data: detail.data,
            error: None,
            read_back_required: true,
        }),
        _ => Ok(GitlabTaskMutationOutcome::unknown(
            "gitlab_read_back_failed",
            "Mutation completed but authoritative read-back failed".into(),
        )),
    }
}

impl GitlabTaskDetailEnvelope {
    fn error(code: &str, message: String) -> Self {
        Self {
            repository: None,
            capabilities: gitlab_capabilities(),
            data: None,
            error: Some(GitlabTaskError {
                code: code.into(),
                message,
            }),
        }
    }
}

impl GitlabTaskMutationOutcome {
    fn unknown(code: &str, message: String) -> Self {
        Self {
            status: "unknown".into(),
            data: None,
            error: Some(GitlabTaskError {
                code: code.into(),
                message,
            }),
            read_back_required: true,
        }
    }
}

fn load_tasks(
    paths: &agentport_core::paths::AppPaths,
    project_id: &str,
    scope: &str,
) -> Result<GitlabTaskEnvelope, (&'static str, String)> {
    if !matches!(scope, "issues" | "pulls" | "boards") {
        return Err((
            "invalid_scope",
            "scope must be issues, pulls, or boards".into(),
        ));
    }
    let db = Db::open_read(paths).map_err(|error| ("project_read_failed", error.to_string()))?;
    let project = db
        .get_project(project_id)
        .map_err(|error| ("project_not_found", error.to_string()))?;
    let checkout = project
        .git_root_path
        .as_deref()
        .unwrap_or(&project.root_path);
    let root = command_text(
        "git",
        &["-C", checkout, "rev-parse", "--show-toplevel"],
        None,
    )
    .map_err(|_| {
        (
            "not_git_repository",
            "The AgentPort project is not a Git checkout".into(),
        )
    })?;
    let (identity, remote_url) = gitlab_remote(&root)?;
    let repository = GitlabTaskRepository {
        host: identity.host.clone(),
        namespace: identity.namespace.clone(),
        name: identity.name.clone(),
        remote_url,
        project_path: identity.project_path.clone(),
    };
    let endpoint = match scope {
        "issues" => format!(
            "projects/{}/issues?per_page={MAX_ITEMS}&order_by=updated_at&sort=desc",
            encode_path(&identity.project_path)
        ),
        "pulls" => format!(
            "projects/{}/merge_requests?per_page={MAX_ITEMS}&order_by=updated_at&sort=desc",
            encode_path(&identity.project_path)
        ),
        "boards" => format!("projects/{}/boards", encode_path(&identity.project_path)),
        _ => unreachable!(),
    };
    let items = glab_api(&root, &identity.host, &endpoint)?;
    Ok(GitlabTaskEnvelope {
        scope: scope.into(),
        repository: Some(repository),
        capabilities: gitlab_capabilities(),
        items,
        error: None,
    })
}

fn gitlab_remote(root: &str) -> Result<(RemoteIdentity, String), (&'static str, String)> {
    let remote = resolve_main_remote(root).map_err(|message| {
        (
            "gitlab_remote_required",
            format!("The origin/main upstream has no supported GitLab remote: {message}"),
        )
    })?;
    if provider_for_remote(&remote) != Some(TaskProvider::Gitlab) {
        return Err((
            "gitlab_remote_required",
            "The origin/main upstream is not a recognized GitLab host".into(),
        ));
    }
    let project_path = gitlab_project_path(&remote);
    if !is_valid_project_path(&project_path) {
        return Err((
            "gitlab_remote_required",
            "The origin/main upstream is not a supported GitLab repository".into(),
        ));
    }
    let normalized_remote = TaskRemote {
        host: remote.host.clone(),
        port: remote.port,
        path: project_path,
    };
    let identity = parse_gitlab_remote(&normalized_remote.canonical_url()).ok_or((
        "gitlab_remote_required",
        "The origin/main upstream is not a supported GitLab repository".into(),
    ))?;
    Ok((identity, remote.canonical_url()))
}

fn parse_gitlab_remote(remote: &str) -> Option<RemoteIdentity> {
    let remote = parse_remote(remote)?;
    if !is_valid_project_path(&remote.path) {
        return None;
    }
    let mut pieces = remote.path.rsplitn(2, '/');
    let name = pieces.next()?.to_owned();
    let namespace = pieces.next()?.to_owned();
    Some(RemoteIdentity {
        host: remote.host,
        project_path: format!("{namespace}/{name}"),
        namespace,
        name,
    })
}

fn encode_path(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                (byte as char).to_string()
            }
            b'/' => "%2F".into(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn glab_api(root: &str, host: &str, endpoint: &str) -> Result<Vec<Value>, (&'static str, String)> {
    let output = command_output("glab", &["api", "--hostname", host, endpoint], Some(root))
        .map_err(|error| ("glab_unavailable", error))?;
    if !output.success {
        let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        let code =
            if stderr.contains("auth") || stderr.contains("login") || stderr.contains("token") {
                "gitlab_auth_required"
            } else {
                "gitlab_request_failed"
            };
        return Err((
            code,
            "GitLab CLI could not complete the read request".into(),
        ));
    }
    let value: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        (
            "gitlab_invalid_response",
            "GitLab returned invalid JSON".into(),
        )
    })?;
    Ok(value.as_array().cloned().unwrap_or_else(|| vec![value]))
}

struct CommandOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn command_text(program: &str, args: &[&str], cwd: Option<&str>) -> Result<String, String> {
    let output = command_output(program, args, cwd)?;
    if !output.success {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn command_output(
    program: &str,
    args: &[&str],
    cwd: Option<&str>,
) -> Result<CommandOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    let mut child = command
        .spawn()
        .map_err(|_| format!("{program} is not available"))?;
    let start = Instant::now();
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
            None if start.elapsed() >= COMMAND_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{program} timed out"));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    }
}

impl GitlabTaskEnvelope {
    fn error(scope: &str, code: &str, message: String) -> Self {
        Self {
            scope: scope.into(),
            repository: None,
            capabilities: gitlab_capabilities(),
            items: Vec::new(),
            error: Some(GitlabTaskError {
                code: code.into(),
                message,
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_gitlab_forms_and_self_hosted() {
        let identity = parse_gitlab_remote("git@git.example.com:group/sub/repo.git").unwrap();
        assert_eq!(identity.host, "git.example.com");
        assert_eq!(identity.project_path, "group/sub/repo");
        assert_eq!(
            parse_gitlab_remote("https://gitlab.com/group/repo.git")
                .unwrap()
                .host,
            "gitlab.com"
        );
    }
    #[test]
    fn encodes_nested_project_paths() {
        assert_eq!(encode_path("group/sub/repo"), "group%2Fsub%2Frepo");
    }
}
