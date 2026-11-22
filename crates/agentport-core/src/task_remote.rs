//! Canonical task-provider remote resolution.
//!
//! Task sources are selected from the repository's `origin` remote (the
//! remote-tracking `origin/main` upstream), never from the current checkout's
//! arbitrary remote. Only normalized host/path data leaves this module; URL
//! credentials, query strings, and fragments are discarded.

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(8);
const CLI_PROBE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRemote {
    /// Hostname used by `gh`/`glab` configuration and authentication.
    pub host: String,
    /// Optional port from the Git remote URL. `glab` keeps its auth key by
    /// hostname, so callers pass `host` to the CLI while this port remains in
    /// the credential-free canonical URL.
    pub port: Option<u16>,
    pub path: String,
}

impl TaskRemote {
    pub fn canonical_url(&self) -> String {
        let authority = self
            .port
            .map(|port| format!("{}:{port}", self.host))
            .unwrap_or_else(|| self.host.clone());
        format!("https://{authority}/{}", self.path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskProvider {
    Github,
    Gitlab,
}

impl TaskProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
        }
    }
}

/// Resolve the repository source used by Task Hub.
///
/// `origin` is authoritative for Task Hub. A configured `upstream` or other
/// branch remote is never allowed to silently replace the project's
/// `origin/main` source.
pub fn resolve_main_remote(root: &str) -> Result<TaskRemote, String> {
    let url = git_text(root, &["remote", "get-url", "origin"])
        .map_err(|_| "origin/main upstream remote is unavailable".to_string())?;
    if url.is_empty() {
        return Err("origin/main upstream remote is unavailable".into());
    }
    parse_remote(&url)
        .ok_or_else(|| "origin/main remote URL is not a supported Git remote URL".into())
}

/// Parse the supported Git remote forms without retaining credentials or URL
/// metadata. This handles scp-style SSH, `ssh://`, and HTTP(S) URLs.
pub fn parse_remote(remote: &str) -> Option<TaskRemote> {
    let remote = remote.trim();
    if remote.is_empty() || remote.chars().any(char::is_whitespace) {
        return None;
    }

    let (authority, raw_path) = if let Some(rest) = remote.strip_prefix("git@") {
        rest.split_once(':')?
    } else if let Some(rest) = remote
        .strip_prefix("ssh://")
        .or_else(|| remote.strip_prefix("https://"))
        .or_else(|| remote.strip_prefix("http://"))
    {
        rest.split_once('/')?
    } else {
        return None;
    };

    let (host, port) = normalize_host(authority)?;
    let path = normalize_path(raw_path)?;
    Some(TaskRemote { host, port, path })
}

pub fn provider_for_host(host: &str) -> Option<TaskProvider> {
    let host = host_without_port(host).trim_end_matches('.');
    if host.eq_ignore_ascii_case("github.com") {
        return Some(TaskProvider::Github);
    }
    // GitLab's CLI accepts arbitrary self-hosted GitLab hostnames. Restrict
    // recognition to an exact `gitlab` DNS label so `git.example.com` and
    // other unknown Git servers remain explicitly unsupported.
    if host.eq_ignore_ascii_case("gitlab.com")
        || host
            .split('.')
            .any(|label| label.eq_ignore_ascii_case("gitlab"))
    {
        return Some(TaskProvider::Gitlab);
    }
    None
}

/// Resolve a self-hosted GitLab host from the device-local `glab` account.
/// The command's output is discarded; only its exit status is observed.
pub fn provider_for_remote(remote: &TaskRemote) -> Option<TaskProvider> {
    provider_for_host(&remote.host).or_else(|| {
        command_succeeded(
            "glab",
            &["auth", "status", "--hostname", remote.host.as_str()],
        )
        .then_some(TaskProvider::Gitlab)
    })
}

/// Remove a GitLab installation subfolder from a repository URL. Self-managed
/// instances may be mounted at `https://host/gitlab/`, while GitLab API paths
/// still start at the project namespace.
pub fn gitlab_project_path(remote: &TaskRemote) -> String {
    let Some(subfolder) = command_text(
        "glab",
        &["config", "get", "subfolder", "--host", remote.host.as_str()],
    )
    .ok()
    .map(|value| value.trim_matches('/').to_owned())
    .filter(|value| valid_subfolder(value)) else {
        return remote.path.clone();
    };
    strip_gitlab_subfolder(&remote.path, &subfolder).unwrap_or_else(|| remote.path.clone())
}

fn strip_gitlab_subfolder(path: &str, subfolder: &str) -> Option<String> {
    path.strip_prefix(subfolder)
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|path| is_valid_project_path(path))
        .map(str::to_owned)
}

pub fn github_repository(path: &str) -> Option<(String, String)> {
    let mut segments = path.split('/');
    let owner = segments.next()?.to_owned();
    let name = segments.next()?.to_owned();
    if segments.next().is_some() || !valid_github_part(&owner) || !valid_github_part(&name) {
        return None;
    }
    Some((owner, name))
}

pub fn is_valid_project_path(path: &str) -> bool {
    let mut segments = path.split('/');
    let first = segments.next();
    let second = segments.next();
    first.is_some_and(valid_path_part)
        && second.is_some_and(valid_path_part)
        && segments.all(valid_path_part)
}

fn normalize_host(authority: &str) -> Option<(String, Option<u16>)> {
    let authority = authority.split(['?', '#']).next()?.trim();
    let host_port = authority.rsplit('@').next()?.trim();
    if host_port.is_empty() {
        return None;
    }
    let (host, port) = if let Some(rest) = host_port.strip_prefix('[') {
        let (host, suffix) = rest.split_once(']')?;
        let port = if suffix.is_empty() {
            None
        } else {
            Some(parse_port(suffix.strip_prefix(':')?)?)
        };
        (host, port)
    } else if let Some((host, port)) = host_port.rsplit_once(':') {
        if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        (host, Some(parse_port(port)?))
    } else {
        (host_port, None)
    };
    if host.is_empty()
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return None;
    }
    Some((host.to_ascii_lowercase(), port))
}

fn parse_port(value: &str) -> Option<u16> {
    let port = value.parse().ok()?;
    (port > 0).then_some(port)
}

fn host_without_port(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(host, _)| host))
        .unwrap_or_else(|| host.rsplit_once(':').map(|(host, _)| host).unwrap_or(host))
}

fn normalize_path(raw_path: &str) -> Option<String> {
    let path = raw_path
        .split(['?', '#'])
        .next()?
        .trim_matches('/')
        .strip_suffix(".git")
        .unwrap_or_else(|| {
            raw_path
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .trim_matches('/')
        })
        .trim_matches('/');
    if path.is_empty() || path.len() > 512 || !is_valid_project_path(path) {
        return None;
    }
    Some(path.to_owned())
}

fn valid_github_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn valid_subfolder(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.split('/').all(valid_path_part)
}

fn valid_path_part(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'~' | b'%')
        })
}

fn git_text(root: &str, args: &[&str]) -> Result<String, String> {
    let mut command_args = vec!["-C", root];
    command_args.extend_from_slice(args);
    command_text("git", &command_args)
}

fn command_text(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
                if !status.success() {
                    return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
                }
                return Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned());
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

fn command_succeeded(program: &str, args: &[&str]) -> bool {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if started.elapsed() >= CLI_PROBE_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_remote_forms_and_strips_metadata() {
        let expected = TaskRemote {
            host: "github.com".into(),
            port: None,
            path: "octo-org/repo".into(),
        };
        assert_eq!(
            parse_remote("git@github.com:octo-org/repo.git"),
            Some(expected.clone())
        );
        assert_eq!(
            parse_remote("ssh://git@github.com:22/octo-org/repo.git?x=1#top"),
            Some(TaskRemote {
                host: "github.com".into(),
                port: Some(22),
                path: "octo-org/repo".into(),
            })
        );
        assert_eq!(
            parse_remote("https://user:secret@github.com/octo-org/repo.git?x=1#top"),
            Some(expected.clone())
        );
        assert_eq!(expected.canonical_url(), "https://github.com/octo-org/repo");
    }

    #[test]
    fn classifies_only_known_provider_hosts() {
        assert_eq!(provider_for_host("github.com"), Some(TaskProvider::Github));
        assert_eq!(provider_for_host("gitlab.com"), Some(TaskProvider::Gitlab));
        assert_eq!(
            provider_for_host("gitlab.corp.example"),
            Some(TaskProvider::Gitlab)
        );
        assert_eq!(provider_for_host("git.example.com"), None);
        assert_eq!(provider_for_host("github.enterprise.example"), None);
        assert_eq!(provider_for_host("not-gitlab.example"), None);
    }

    #[test]
    fn strips_self_hosted_gitlab_installation_subfolders() {
        assert_eq!(
            strip_gitlab_subfolder("gitlab/tiandriver/tiandrive", "gitlab"),
            Some("tiandriver/tiandrive".into())
        );
        assert_eq!(
            strip_gitlab_subfolder("gitlabx/tiandriver/tiandrive", "gitlab"),
            None
        );
    }

    #[test]
    fn rejects_malformed_and_ambiguous_remotes() {
        assert_eq!(parse_remote("file:///tmp/repo"), None);
        assert_eq!(parse_remote("https://github.com/owner"), None);
        assert_eq!(
            parse_remote("https://github.com/owner/repo/issues"),
            Some(TaskRemote {
                host: "github.com".into(),
                port: None,
                path: "owner/repo/issues".into()
            })
        );
        assert_eq!(parse_remote("https://github.com/owner/../repo"), None);
    }

    #[test]
    fn prefers_origin_over_an_unrelated_main_branch_remote() {
        let root = std::env::temp_dir().join(format!(
            "agentport-task-remote-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(["-C", root.to_str().unwrap()])
                .args(args)
                .status()
                .unwrap();
            assert!(status.success(), "git {:?} failed", args);
        };
        run(&["init", "--quiet"]);
        run(&[
            "remote",
            "add",
            "origin",
            "https://github.com/octo-org/from-origin.git",
        ]);
        run(&[
            "remote",
            "add",
            "upstream",
            "https://gitlab.com/group/from-upstream.git",
        ]);
        run(&["config", "branch.main.remote", "upstream"]);
        run(&["config", "branch.main.merge", "refs/heads/main"]);

        let remote = resolve_main_remote(root.to_str().unwrap()).unwrap();
        assert_eq!(remote.host, "github.com");
        assert_eq!(remote.path, "octo-org/from-origin");
        run(&["remote", "remove", "origin"]);
        assert!(resolve_main_remote(root.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(root);
    }
}
