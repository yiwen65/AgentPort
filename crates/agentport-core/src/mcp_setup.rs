//! One-click MCP registration for the Agents AgentPort launches.
//!
//! Each CLI owns its own MCP configuration; AgentPort never hand-edits those
//! files when the CLI exposes a management command, and never rewrites a file
//! it cannot parse. Every write is an explicit user toggle, targets only the
//! entry named [`SERVER_NAME`], and is reversible through the same toggle.
//!
//! Support is not guessed: an Agent appears as "supported" only when this
//! module knows a verified mechanism (a CLI subcommand, or a documented JSON
//! file). Everything else reports why it is unavailable.

use crate::error::{CoreError, Result};
use crate::models::{AdapterInstall, AgentType};
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Name of the entry AgentPort creates in each Agent's configuration.
pub const SERVER_NAME: &str = "agentport";
/// Subcommand timeouts: provider CLIs are Node programs and can take seconds.
const CLI_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationState {
    /// Entry present and managed by AgentPort.
    Registered,
    /// No entry for this Agent.
    Missing,
    /// AgentPort knows no safe mechanism for this Agent.
    Unsupported,
    /// The CLI ran but its answer could not be read.
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrationReport {
    pub agent: AgentType,
    pub state: RegistrationState,
    /// Where the registration lives (`~/.claude.json`, CLI name, …).
    pub target: String,
    /// Binary path AgentPort would register, when it is available.
    pub command: Option<String>,
    pub detail: String,
}

impl RegistrationReport {
    pub fn is_supported(&self) -> bool {
        !matches!(self.state, RegistrationState::Unsupported)
    }
}

/// How one Agent accepts an MCP server definition.
enum Mechanism {
    /// `<exe> mcp add …` / `rm …` / `ls …`.
    Cli {
        add: Vec<String>,
        remove: Vec<String>,
        list: Vec<String>,
        /// Output shape of `ls`.
        format: ListFormat,
        target: String,
    },
    /// A documented user-level JSON file with an `mcpServers` object.
    JsonFile { path: PathBuf },
    Unsupported(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListFormat {
    /// One `name: …` line per server.
    ColonLines,
    /// First whitespace-separated column of each line (plus a header).
    FirstColumn,
    /// `{"servers":[...]}` (easy-pi / Pi).
    ServersObject,
    /// A JSON array of server objects (grok).
    Array,
}

/// Resolve the mechanism for an Agent. `install` supplies the verified
/// executable so no PATH lookup can select a different build.
fn mechanism(agent: AgentType, install: &AdapterInstall, mcp_bin: &Path) -> Mechanism {
    let exe = install.executable_path.clone();
    let (program, args) = (mcp_bin.to_string_lossy().to_string(), "serve --stdio");
    let server_command: Vec<String> = vec![program.clone(), "serve".into(), "--stdio".into()];
    let _ = args;
    match agent {
        AgentType::Claude => Mechanism::Cli {
            add: chain(&exe, &["mcp", "add", "-s", "user", SERVER_NAME, "--"], &server_command),
            remove: vec![exe, "mcp".into(), "remove".into(), "-s".into(), "user".into(), SERVER_NAME.into()],
            list: vec![install.executable_path.clone(), "mcp".into(), "list".into()],
            format: ListFormat::ColonLines,
            target: "claude mcp (user scope)".into(),
        },
        AgentType::Codex => Mechanism::Cli {
            add: chain(&exe, &["mcp", "add", SERVER_NAME, "--"], &server_command),
            remove: vec![exe, "mcp".into(), "remove".into(), SERVER_NAME.into()],
            list: vec![install.executable_path.clone(), "mcp".into(), "list".into()],
            format: ListFormat::FirstColumn,
            target: "codex mcp (~/.codex/config.toml)".into(),
        },
        AgentType::EasyPi => Mechanism::Cli {
            add: chain(&exe, &["mcp", "add", SERVER_NAME, "--"], &server_command),
            remove: vec![exe, "mcp".into(), "remove".into(), SERVER_NAME.into()],
            list: vec![install.executable_path.clone(), "mcp".into(), "list".into(), "--json".into()],
            format: ListFormat::ServersObject,
            target: "epi mcp (~/.epi/agent/mcp.json)".into(),
        },
        AgentType::Pi => Mechanism::Cli {
            add: chain(&exe, &["mcp", "add", SERVER_NAME, "--"], &server_command),
            remove: vec![exe, "mcp".into(), "remove".into(), SERVER_NAME.into()],
            list: vec![install.executable_path.clone(), "mcp".into(), "list".into(), "--json".into()],
            format: ListFormat::ServersObject,
            target: "pi mcp (~/.pi/agent/mcp.json)".into(),
        },
        AgentType::Qoder => Mechanism::Cli {
            add: chain(&exe, &["mcp", "add", "-s", "user", SERVER_NAME], &server_command),
            remove: vec![exe, "mcp".into(), "remove".into(), "-s".into(), "user".into(), SERVER_NAME.into()],
            list: vec![install.executable_path.clone(), "mcp".into(), "list".into()],
            format: ListFormat::ColonLines,
            target: "qodercli mcp (user scope)".into(),
        },
        AgentType::GrokBuild => Mechanism::Cli {
            add: chain(&exe, &["mcp", "add", SERVER_NAME, "--"], &server_command),
            remove: vec![exe, "mcp".into(), "remove".into(), SERVER_NAME.into()],
            list: vec![install.executable_path.clone(), "mcp".into(), "list".into(), "--json".into()],
            format: ListFormat::Array,
            target: "grok mcp".into(),
        },
        // Cursor keeps MCP servers in a plain JSON file; the CLI can list,
        // enable and disable, but not add.
        AgentType::CursorAgent => Mechanism::JsonFile {
            path: home_dir().join(".cursor").join("mcp.json"),
        },
        AgentType::Kimi => Mechanism::Unsupported(
            "Kimi Code has no MCP management command; its config.toml is left untouched".into(),
        ),
        AgentType::Omp => Mechanism::Unsupported(
            "oh-my-pi exposes no MCP management command".into(),
        ),
        AgentType::Opencode
        | AgentType::Amp
        | AgentType::Gemini
        | AgentType::Cline
        | AgentType::KiroCli
        | AgentType::Shell => Mechanism::Unsupported(
            "AgentPort has no verified MCP registration mechanism for this Agent yet".into(),
        ),
    }
}

fn chain(program: &str, head: &[&str], tail: &[String]) -> Vec<String> {
    let mut argv = vec![program.to_string()];
    argv.extend(head.iter().map(|value| value.to_string()));
    argv.extend(tail.iter().cloned());
    argv
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Report the current registration without changing anything.
pub fn status(agent: AgentType, install: &AdapterInstall, mcp_bin: &Path) -> RegistrationReport {
    let spec = mechanism(agent, install, mcp_bin);
    let command = mcp_bin.is_file().then(|| mcp_bin.display().to_string());
    match spec {
        Mechanism::Unsupported(reason) => RegistrationReport {
            agent,
            state: RegistrationState::Unsupported,
            target: String::new(),
            command,
            detail: reason,
        },
        Mechanism::JsonFile { path } => match read_json_servers(&path) {
            Ok(Some(existing)) => RegistrationReport {
                agent,
                state: if existing.contains_key(SERVER_NAME) {
                    RegistrationState::Registered
                } else {
                    RegistrationState::Missing
                },
                target: path.display().to_string(),
                command,
                detail: String::new(),
            },
            Ok(None) => RegistrationReport {
                agent,
                state: RegistrationState::Missing,
                target: path.display().to_string(),
                command,
                detail: String::new(),
            },
            Err(error) => RegistrationReport {
                agent,
                state: RegistrationState::Unknown,
                target: path.display().to_string(),
                command,
                detail: format!("could not read {}: {error}", path.display()),
            },
        },
        Mechanism::Cli { list, format, target, .. } => {
            let program = list.first().cloned().unwrap_or_default();
            match run(&program, &list[1..], CLI_TIMEOUT) {
                Ok(outcome) => {
                    let names = parse_names(&outcome.stdout, format);
                    match names {
                        Some(names) => RegistrationReport {
                            agent,
                            state: if names.iter().any(|name| name == SERVER_NAME) {
                                RegistrationState::Registered
                            } else {
                                RegistrationState::Missing
                            },
                            target,
                            command,
                            detail: String::new(),
                        },
                        None => RegistrationReport {
                            agent,
                            state: RegistrationState::Unknown,
                            target,
                            command,
                            detail: format!(
                                "`{program} mcp list`输出的无法解析：{}",
                                first_line(&outcome.stdout).or_else(|| first_line(&outcome.stderr)).unwrap_or_default()
                            ),
                        },
                    }
                }
                Err(error) => RegistrationReport {
                    agent,
                    state: RegistrationState::Unknown,
                    target,
                    command,
                    detail: error.to_string(),
                },
            }
        }
    }
}

/// Add or remove the AgentPort entry. Returns the fresh status afterwards.
pub fn set(
    agent: AgentType,
    install: &AdapterInstall,
    mcp_bin: &Path,
    enable: bool,
) -> Result<RegistrationReport> {
    if !mcp_bin.is_file() {
        return Err(CoreError::Validation(format!(
            "the AgentPort build is missing {}; MCP registration is unavailable",
            mcp_bin.display()
        )));
    }
    match mechanism(agent, install, mcp_bin) {
        Mechanism::Unsupported(reason) => Err(CoreError::Blocked(reason)),
        Mechanism::JsonFile { path } => {
            if enable {
                add_json_server(&path, mcp_bin)?;
            } else {
                remove_json_server(&path)?;
            }
            Ok(status(agent, install, mcp_bin))
        }
        Mechanism::Cli { add, remove, .. } => {
            let argv = if enable { add } else { remove };
            let program = argv.first().cloned().unwrap_or_default();
            let outcome = run(&program, &argv[1..], CLI_TIMEOUT)?;
            if !outcome.success {
                return Err(CoreError::Validation(format!(
                    "`{program} mcp {}` failed: {}",
                    if enable { "add" } else { "remove" },
                    first_line(&outcome.stderr)
                        .or_else(|| first_line(&outcome.stdout))
                        .unwrap_or_else(|| "no output".into())
                )));
            }
            let report = status(agent, install, mcp_bin);
            // Trust the CLI's own listing over the exit code: several of them
            // succeed even when they wrote nothing.
            let expected = if enable {
                RegistrationState::Registered
            } else {
                RegistrationState::Missing
            };
            if report.state != expected {
                return Err(CoreError::Validation(format!(
                    "`{program} mcp {}` did not change the registration (state: {:?}) {}",
                    if enable { "add" } else { "remove" },
                    report.state,
                    report.detail
                )));
            }
            Ok(report)
        }
    }
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

struct Outcome {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Run a provider CLI without a shell, with a hard timeout. A hung provider CLI
/// must never wedge the settings dialog.
fn run(program: &str, args: &[String], timeout: Duration) -> Result<Outcome> {
    let mut child = Command::new(program)
        .args(args.iter().map(OsStr::new))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| CoreError::Validation(format!("could not run {program}: {error}")))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CoreError::Validation(format!(
                        "{program} did not answer within {}s",
                        timeout.as_secs()
                    )));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(CoreError::Validation(format!(
                    "{program} could not be observed: {error}"
                )))
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| CoreError::Validation(format!("{program} output unreadable: {error}")))?;
    Ok(Outcome {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| line.chars().take(300).collect())
}

/// Server names from a provider CLI listing. `None` means "unparseable", which
/// must not be reported as "not registered".
fn parse_names(stdout: &str, format: ListFormat) -> Option<Vec<String>> {
    match format {
        ListFormat::ColonLines => {
            let mut names = Vec::new();
            for line in stdout.lines() {
                let Some((name, _)) = line.split_once(':') else {
                    continue;
                };
                let name = name.trim();
                if !name.is_empty() && !name.contains(char::is_whitespace) {
                    names.push(name.to_string());
                }
            }
            // Text listings that say nothing about servers still mean "none".
            Some(names)
        }
        ListFormat::FirstColumn => {
            let mut names = Vec::new();
            for line in stdout.lines() {
                let Some(first) = line.split_whitespace().next() else {
                    continue;
                };
                if first.eq_ignore_ascii_case("name") {
                    continue;
                }
                names.push(first.to_string());
            }
            Some(names)
        }
        ListFormat::ServersObject => {
            let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
            let servers = value.get("servers")?.as_array()?;
            Some(
                servers
                    .iter()
                    .filter_map(|server| {
                        server
                            .get("name")
                            .or_else(|| server.get("id"))
                            .and_then(|name| name.as_str())
                            .map(str::to_string)
                    })
                    .collect(),
            )
        }
        ListFormat::Array => {
            let value: serde_json::Value = serde_json::from_str(stdout).ok()?;
            let servers = value.as_array()?;
            Some(
                servers
                    .iter()
                    .filter_map(|server| {
                        server
                            .get("name")
                            .or_else(|| server.get("id"))
                            .and_then(|name| name.as_str())
                            .map(str::to_string)
                    })
                    .collect(),
            )
        }
    }
}

// ---------------------------------------------------------------------------
// JSON config (Cursor)
// ---------------------------------------------------------------------------

type JsonObject = serde_json::Map<String, serde_json::Value>;

/// `Ok(None)` = file does not exist yet.
fn read_json_servers(path: &Path) -> Result<Option<JsonObject>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CoreError::Validation(format!(
                "could not read {}: {error}",
                path.display()
            )))
        }
    };
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(Some(JsonObject::new()));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
        CoreError::Validation(format!(
            "{} is not valid JSON ({error}); refusing to rewrite it",
            path.display()
        ))
    })?;
    match value.get("mcpServers") {
        None => Ok(Some(JsonObject::new())),
        Some(serde_json::Value::Object(map)) => Ok(Some(map.clone())),
        Some(_) => Err(CoreError::Validation(format!(
            "{} has a non-object mcpServers; refusing to rewrite it",
            path.display()
        ))),
    }
}

fn add_json_server(path: &Path, mcp_bin: &Path) -> Result<()> {
    let mut document = read_document(path)?;
    let Some(root) = document.as_object_mut() else {
        return Err(CoreError::Validation(format!(
            "{} is not a JSON object; refusing to rewrite it",
            path.display()
        )));
    };
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::Value::Object(JsonObject::new()));
    let Some(servers) = servers.as_object_mut() else {
        return Err(CoreError::Validation(format!(
            "{} has a non-object mcpServers",
            path.display()
        )));
    };
    if let Some(existing) = servers.get(SERVER_NAME) {
        let ours = existing
            .get("command")
            .and_then(|value| value.as_str())
            .is_some_and(|command| command == mcp_bin.to_string_lossy());
        if !ours {
            // Someone else's entry under our name is theirs to keep.
            return Err(CoreError::Conflict(format!(
                "{} already defines an \"{SERVER_NAME}\" MCP server; remove it first",
                path.display()
            )));
        }
    }
    servers.insert(
        SERVER_NAME.to_string(),
        serde_json::json!({
            "command": mcp_bin.to_string_lossy(),
            "args": ["serve", "--stdio"],
        }),
    );
    write_document(path, &document)
}

fn remove_json_server(path: &Path) -> Result<()> {
    let mut document = read_document(path)?;
    let Some(servers) = document
        .get_mut("mcpServers")
        .and_then(|value| value.as_object_mut())
    else {
        return Ok(());
    };
    servers.remove(SERVER_NAME);
    write_document(path, &document)
}

fn read_document(path: &Path) -> Result<serde_json::Value> {
    match fs::read(path) {
        Ok(bytes) if !bytes.iter().all(|byte| byte.is_ascii_whitespace()) => {
            serde_json::from_slice(&bytes).map_err(|error| {
                CoreError::Validation(format!(
                    "{} is not valid JSON ({error}); refusing to rewrite it",
                    path.display()
                ))
            })
        }
        Ok(_) => Ok(serde_json::json!({})),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(error) => Err(CoreError::Validation(format!(
            "could not read {}: {error}",
            path.display()
        ))),
    }
}

/// Atomic, mode-preserving write: a provider config must never be truncated.
fn write_document(path: &Path, document: &serde_json::Value) -> Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let mode = fs::metadata(path).map(|meta| meta.permissions().mode() & 0o777).unwrap_or(0o600);
    let body = serde_json::to_vec_pretty(document)?;
    let tmp = path.with_extension("agentport-tmp");
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(mode)
            .open(&tmp)?;
        file.write_all(&body)?;
        file.sync_all()?;
    }
    fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn install(agent: AgentType, exe: &str) -> AdapterInstall {
        AdapterInstall {
            agent_type: agent,
            executable_path: exe.into(),
            version_text: "test".into(),
            capability_hash: "sha256:test".into(),
            exact_resume: false,
            hook_status: crate::models::HookStatus::Unavailable,
            approval_model: crate::models::ApprovalModel::NativePrompts,
            default_transport: crate::models::AgentTransport::Pty,
            probed_at: chrono::Utc::now(),
            candidates: Vec::new(),
            flags: Vec::new(),
        }
    }

    #[test]
    fn claude_registers_in_user_scope_after_a_separator() {
        let spec = mechanism(AgentType::Claude, &install(AgentType::Claude, "/bin/claude"), Path::new("/app/agentport-mcp"));
        let Mechanism::Cli { add, remove, .. } = spec else {
            panic!("claude must use its CLI");
        };
        assert_eq!(
            add,
            vec![
                "/bin/claude", "mcp", "add", "-s", "user", "agentport", "--",
                "/app/agentport-mcp", "serve", "--stdio"
            ]
        );
        assert_eq!(remove, vec!["/bin/claude", "mcp", "remove", "-s", "user", "agentport"]);
    }

    #[test]
    fn qoder_uses_user_scope_before_the_name() {
        let spec = mechanism(AgentType::Qoder, &install(AgentType::Qoder, "/bin/qodercli"), Path::new("/app/agentport-mcp"));
        let Mechanism::Cli { add, .. } = spec else {
            panic!("qoder must use its CLI");
        };
        assert_eq!(
            add,
            vec![
                "/bin/qodercli", "mcp", "add", "-s", "user", "agentport",
                "/app/agentport-mcp", "serve", "--stdio"
            ]
        );
    }

    #[test]
    fn unverified_agents_are_reported_unsupported_rather_than_guessed() {
        for agent in [AgentType::Kimi, AgentType::Omp, AgentType::Amp, AgentType::Shell] {
            let report = status(agent, &install(agent, "/bin/x"), Path::new("/app/agentport-mcp"));
            assert_eq!(report.state, RegistrationState::Unsupported, "{agent:?}");
            assert!(!report.detail.is_empty());
            assert!(!report.is_supported());
        }
    }

    #[test]
    fn text_listings_are_parsed_by_shape() {
        let claude = "Checking MCP server health…\n\ncua-driver: /bin/x mcp - ✔ Connected\nagentport: /app/agentport-mcp serve --stdio - ✔ Connected\n";
        assert_eq!(
            parse_names(claude, ListFormat::ColonLines).unwrap(),
            vec!["cua-driver".to_string(), "agentport".to_string()]
        );
        let codex = "Name   Command   Args\nRepoPrompt  /x\nagentport   /app\n";
        assert_eq!(
            parse_names(codex, ListFormat::FirstColumn).unwrap(),
            vec!["RepoPrompt".to_string(), "agentport".to_string()]
        );
        assert_eq!(parse_names("No MCP servers configured.", ListFormat::ColonLines).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn json_listings_must_parse() {
        let pi = r#"{"servers":[{"name":"agentport","command":"/app"}],"errors":[]}"#;
        assert_eq!(
            parse_names(pi, ListFormat::ServersObject).unwrap(),
            vec!["agentport".to_string()]
        );
        assert!(parse_names("not json", ListFormat::ServersObject).is_none());
        let grok = r#"[{"name":"agentport"}]"#;
        assert_eq!(
            parse_names(grok, ListFormat::Array).unwrap(),
            vec!["agentport".to_string()]
        );
    }

    #[test]
    fn cursor_json_round_trips_without_touching_other_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(
            &path,
            r#"{"theme":"dark","mcpServers":{"other":{"command":"/bin/other"}}}"#,
        )
        .unwrap();
        let bin = Path::new("/app/agentport-mcp");
        add_json_server(&path, bin).unwrap();
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["theme"], "dark");
        assert_eq!(document["mcpServers"]["other"]["command"], "/bin/other");
        assert_eq!(document["mcpServers"]["agentport"]["args"][0], "serve");

        remove_json_server(&path).unwrap();
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(document["mcpServers"].get("agentport").is_none());
        assert_eq!(document["mcpServers"]["other"]["command"], "/bin/other");
        assert_eq!(document["theme"], "dark");
    }

    #[test]
    fn malformed_json_is_never_rewritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(&path, "{oops").unwrap();
        let error = add_json_server(&path, Path::new("/app/agentport-mcp")).unwrap_err();
        assert!(format!("{error}").contains("not valid JSON"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{oops");
    }

    #[test]
    fn a_foreign_entry_under_our_name_is_a_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(&path, r#"{"mcpServers":{"agentport":{"command":"/somewhere/else"}}}"#).unwrap();
        let error = add_json_server(&path, Path::new("/app/agentport-mcp")).unwrap_err();
        assert!(matches!(error, CoreError::Conflict(_)));
    }

    #[test]
    fn missing_binary_blocks_registration() {
        let dir = tempfile::tempdir().unwrap();
        let report = status(
            AgentType::Claude,
            &install(AgentType::Claude, "/bin/claude"),
            &dir.path().join("absent"),
        );
        assert!(report.command.is_none());
        let error = set(
            AgentType::Claude,
            &install(AgentType::Claude, "/bin/claude"),
            &dir.path().join("absent"),
            true,
        )
        .unwrap_err();
        assert!(format!("{error}").contains("missing"));
    }
}
