//! Read-only GitHub task discovery for the local desktop project.
//!
//! Authentication remains owned by the user's `gh` installation. This module
//! never reads, persists, or logs credentials; it only passes bounded,
//! repository-scoped read requests to `gh api`.

use agentport_core::db::Db;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

use crate::AppState;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_ITEMS: usize = 50;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubTaskEnvelope {
    pub scope: String,
    pub repository: Option<GithubRepository>,
    pub data: Option<GithubTaskData>,
    pub error: Option<GithubTaskError>,
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
    labels: Vec<LabelApi>,
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
    draft: bool,
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
    let remotes = run_command("git", ["-C", root, "remote"], None)
        .map_err(|message| ("git_remote_failed", message))?;
    if !remotes.success {
        return Err(("git_remote_failed", "Could not list Git remotes".into()));
    }
    let names = text_output(&remotes.stdout);
    for name in names.lines().map(str::trim).filter(|name| !name.is_empty()) {
        let output = match run_command("git", ["-C", root, "remote", "get-url", name], None) {
            Ok(output) if output.success => output,
            _ => continue,
        };
        let remote_url = text_output(&output.stdout);
        if let Some(identity) = parse_github_remote(&remote_url) {
            return Ok((identity, remote_url));
        }
    }
    Err((
        "github_remote_required",
        "The checkout has no supported github.com remote".into(),
    ))
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
    let remote = remote.trim();
    let (host, path) = if let Some(rest) = remote.strip_prefix("https://") {
        let (host, path) = rest.split_once('/')?;
        (host.split('@').next_back()?, path)
    } else if let Some(rest) = remote.strip_prefix("http://") {
        let (host, path) = rest.split_once('/')?;
        (host.split('@').next_back()?, path)
    } else if let Some(rest) = remote.strip_prefix("ssh://") {
        let (host, path) = rest.split_once('/')?;
        (
            host.split('@')
                .next_back()?
                .split(':')
                .next()
                .unwrap_or(host),
            path,
        )
    } else if let Some(rest) = remote.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        (host, path)
    } else {
        return None;
    };
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let path = path
        .split(['?', '#'])
        .next()
        .unwrap_or(path)
        .trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segments = path.split('/');
    let owner = segments.next()?.trim();
    let name = segments.next()?.trim();
    if segments.next().is_some() || !valid_repo_part(owner) || !valid_repo_part(name) {
        return None;
    }
    Some(RemoteIdentity {
        owner: owner.into(),
        name: name.into(),
    })
}

fn valid_repo_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

impl GithubTaskEnvelope {
    fn empty(scope: &str) -> Self {
        Self {
            scope: scope.to_owned(),
            repository: None,
            data: None,
            error: None,
        }
    }

    fn error(scope: &str, code: &str, message: String) -> Self {
        Self {
            scope: scope.to_owned(),
            repository: None,
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
    fn normalizes_issue_pull_request_entries() {
        let json = br#"[{"number":1,"title":"issue","state":"open","html_url":"https://github.com/o/r/issues/1","user":{"login":"octo"},"updated_at":null,"labels":[],"pull_request":null}]"#;
        let entries: Vec<IssueApi> = parse_json(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].pull_request.is_none());
    }
}
