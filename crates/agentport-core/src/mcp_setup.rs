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
    /// A documented user-level JSON file holding a server map.
    JsonFile {
        target: JsonFileTarget,
    },
    Unsupported(String),
}

/// Which file, which top-level key, and which entry shape an Agent expects.
///
/// Every one of these is a documented user-level config; the shapes differ only
/// in how a stdio server is spelled.
#[derive(Debug, Clone)]
pub struct JsonFileTarget {
    pub path: PathBuf,
    /// `mcpServers` for most clients, `mcp` for OpenCode, and Amp's dotted
    /// `amp.mcpServers` key.
    pub key: &'static str,
    pub shape: JsonEntryShape,
    /// A sibling file whose presence means we must not guess (e.g. OpenCode's
    /// JSONC config, which serde cannot round-trip losslessly).
    pub blocker: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonEntryShape {
    /// `{"command": "bin", "args": [...]}` — Claude, Cursor, Kimi, Kiro, Gemini, oh-my-pi.
    CommandArgs,
    /// `{"type": "local", "command": [bin, ...], "enabled": true}` — OpenCode.
    OpenCodeLocal,
    /// `{"command": "bin", "args": [...], "disabled": false, "autoApprove": []}` — Cline.
    ClineCommandArgs,
}

fn json_servers(path: PathBuf) -> JsonFileTarget {
    JsonFileTarget {
        path,
        key: "mcpServers",
        shape: JsonEntryShape::CommandArgs,
        blocker: None,
    }
}

fn agent_dir(env: &str, default: &str) -> PathBuf {
    std::env::var_os(env)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(default))
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
        // These clients keep MCP servers in a plain user-level JSON file; each
        // shape below follows that client's own documentation.
        //
        // Cursor's CLI can list/enable/disable but not add.
        AgentType::CursorAgent => Mechanism::JsonFile {
            target: json_servers(home_dir().join(".cursor").join("mcp.json")),
        },
        AgentType::Kimi => Mechanism::JsonFile {
            target: json_servers(agent_dir("KIMI_CODE_HOME", ".kimi-code").join("mcp.json")),
        },
        AgentType::Omp => Mechanism::JsonFile {
            target: json_servers(
                agent_dir("PI_CODING_AGENT_DIR", ".omp/agent").join("mcp.json"),
            ),
        },
        AgentType::Gemini => Mechanism::JsonFile {
            target: json_servers(agent_dir("GEMINI_CLI_HOME", ".gemini").join("settings.json")),
        },
        AgentType::KiroCli => Mechanism::JsonFile {
            target: json_servers(home_dir().join(".kiro").join("settings").join("mcp.json")),
        },
        AgentType::Opencode => {
            let dir = home_dir().join(".config").join("opencode");
            Mechanism::JsonFile {
                target: JsonFileTarget {
                    path: dir.join("opencode.json"),
                    key: "mcp",
                    shape: JsonEntryShape::OpenCodeLocal,
                    // A JSONC config cannot be merged without losing comments.
                    blocker: Some("opencode.jsonc"),
                },
            }
        }
        AgentType::Amp => Mechanism::JsonFile {
            target: JsonFileTarget {
                path: home_dir().join(".config").join("amp").join("settings.json"),
                // Amp namespaces the map under a dotted key.
                key: "amp.mcpServers",
                shape: JsonEntryShape::CommandArgs,
                blocker: None,
            },
        },
        AgentType::Cline => Mechanism::JsonFile {
            target: JsonFileTarget {
                path: std::env::var_os("CLINE_MCP_SETTINGS_PATH")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        home_dir()
                            .join(".cline")
                            .join("data")
                            .join("settings")
                            .join("cline_mcp_settings.json")
                    }),
                key: "mcpServers",
                shape: JsonEntryShape::ClineCommandArgs,
                blocker: None,
            },
        },
        AgentType::Shell => Mechanism::Unsupported(
            "Generic Shell has no MCP client at all".into(),
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
        Mechanism::JsonFile { target } => {
            if let Some(blocker) = blocked_by_sibling(&target) {
                return RegistrationReport {
                    agent,
                    state: RegistrationState::Unsupported,
                    target: target.path.display().to_string(),
                    command,
                    detail: blocker,
                };
            }
            match read_json_servers(&target) {
                Ok(Some(existing)) => RegistrationReport {
                    agent,
                    state: if existing.contains_key(SERVER_NAME) {
                        RegistrationState::Registered
                    } else {
                        RegistrationState::Missing
                    },
                    target: target.path.display().to_string(),
                    command,
                    detail: String::new(),
                },
                Ok(None) => RegistrationReport {
                    agent,
                    state: RegistrationState::Missing,
                    target: target.path.display().to_string(),
                    command,
                    detail: String::new(),
                },
                Err(error) => RegistrationReport {
                    agent,
                    state: RegistrationState::Unknown,
                    target: target.path.display().to_string(),
                    command,
                    detail: format!("could not read {}: {error}", target.path.display()),
                },
            }
        }
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
        Mechanism::JsonFile { target } => {
            if let Some(blocker) = blocked_by_sibling(&target) {
                return Err(CoreError::Blocked(blocker));
            }
            if enable {
                add_json_server(&target, mcp_bin)?;
            } else {
                remove_json_server(&target)?;
            }
            Ok(status(agent, install, mcp_bin))
        }
        Mechanism::Cli { add, remove, .. } => {
            let argv = if enable { add } else { remove };
            let program = argv.first().cloned().unwrap_or_default();
            let outcome = run(&program, &argv[1..], CLI_TIMEOUT)?;
            if !outcome.success {
                let message = first_line(&outcome.stderr)
                    .or_else(|| first_line(&outcome.stdout))
                    .unwrap_or_else(|| "no output".into());
                // The end state is what matters: several CLIs refuse to add a
                // server that is already configured (and to remove one that is
                // not). Verify before treating that as a failure — a toggle the
                // user has already asked for must not surface as an error.
                let already = if enable {
                    message.to_ascii_lowercase().contains("already exists")
                } else {
                    let lower = message.to_ascii_lowercase();
                    // "No MCP server found with name …", "not found", "no such
                    // server": every client words the absence differently.
                    lower.contains("not found")
                        || lower.contains("does not exist")
                        || lower.contains("no mcp server")
                        || lower.contains("no such")
                };
                if already {
                    let report = status(agent, install, mcp_bin);
                    let expected = if enable {
                        RegistrationState::Registered
                    } else {
                        RegistrationState::Missing
                    };
                    if report.state == expected {
                        // "Already exists" only means our name is taken. If the
                        // existing entry points at another build, enabling must
                        // say so instead of reporting a registration that will
                        // launch something else.
                        if !enable || registered_command_matches(agent, install, mcp_bin) {
                            return Ok(report);
                        }
                        return Err(CoreError::Conflict(format!(
                            "an \"{SERVER_NAME}\" MCP server is already registered for {} and \
                             points at a different build; remove it with the client's own \
                             `mcp remove` and enable this switch again",
                            agent.display_name()
                        )));
                    }
                }
                return Err(CoreError::Validation(format!(
                    "`{program} mcp {}` failed: {message}",
                    if enable { "add" } else { "remove" }
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

/// Does the listed entry for our name launch the binary we would register?
fn registered_command_matches(
    agent: AgentType,
    install: &AdapterInstall,
    mcp_bin: &Path,
) -> bool {
    let Mechanism::Cli { list, .. } = mechanism(agent, install, mcp_bin) else {
        return true;
    };
    let program = list.first().cloned().unwrap_or_default();
    let Ok(outcome) = run(&program, &list[1..], CLI_TIMEOUT) else {
        return true;
    };
    let bin = mcp_bin.to_string_lossy();
    outcome.stdout.lines().any(|line| {
        line.contains(SERVER_NAME)
            && line
                .split_once(':')
                .map(|(name, rest)| {
                    name.contains(SERVER_NAME) && rest.contains(bin.as_ref())
                })
                .unwrap_or_else(|| line.contains(bin.as_ref()))
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
                // Qoder prefixes the row with a status glyph ("✓ agentport: …"),
                // so strip leading decoration before deciding a line is a name.
                let name: String = name
                    .trim()
                    .trim_start_matches(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
                    .trim()
                    .to_string();
                if !name.is_empty() && !name.contains(char::is_whitespace) {
                    names.push(name);
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

/// A sibling config we refuse to rewrite (documented per Agent).
fn blocked_by_sibling(target: &JsonFileTarget) -> Option<String> {
    let sibling = target.blocker?;
    let path = target.path.with_file_name(sibling);
    path.exists().then(|| {
        format!(
            "{} exists next to {}; editing only the JSON file would change which config wins, \
             so AgentPort leaves both alone",
            path.display(),
            target.path.display()
        )
    })
}

/// `Ok(None)` = file does not exist yet.
fn read_json_servers(target: &JsonFileTarget) -> Result<Option<JsonObject>> {
    let path = &target.path;
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
    match value.get(target.key) {
        None => Ok(Some(JsonObject::new())),
        Some(serde_json::Value::Object(map)) => Ok(Some(map.clone())),
        Some(_) => Err(CoreError::Validation(format!(
            "{} has a non-object {}; refusing to rewrite it",
            path.display(),
            target.key
        ))),
    }
}

/// The entry this client should receive for one stdio server.
fn server_entry(target: &JsonFileTarget, mcp_bin: &Path) -> serde_json::Value {
    let bin = mcp_bin.to_string_lossy().to_string();
    match target.shape {
        JsonEntryShape::CommandArgs => serde_json::json!({
            "command": bin,
            "args": ["serve", "--stdio"],
        }),
        JsonEntryShape::OpenCodeLocal => serde_json::json!({
            "type": "local",
            "command": [bin, "serve", "--stdio"],
            "enabled": true,
        }),
        JsonEntryShape::ClineCommandArgs => serde_json::json!({
            "command": bin,
            "args": ["serve", "--stdio"],
            "disabled": false,
            "autoApprove": [],
        }),
    }
}

fn add_json_server(target: &JsonFileTarget, mcp_bin: &Path) -> Result<()> {
    let path = &target.path;
    let mut document = read_document(path)?;
    let Some(root) = document.as_object_mut() else {
        return Err(CoreError::Validation(format!(
            "{} is not a JSON object; refusing to rewrite it",
            path.display()
        )));
    };
    let servers = root
        .entry(target.key.to_string())
        .or_insert_with(|| serde_json::Value::Object(JsonObject::new()));
    let Some(servers) = servers.as_object_mut() else {
        return Err(CoreError::Validation(format!(
            "{} has a non-object {}",
            path.display(),
            target.key
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
    servers.insert(SERVER_NAME.to_string(), server_entry(target, mcp_bin));
    write_document(path, &document)
}

fn remove_json_server(target: &JsonFileTarget) -> Result<()> {
    let path = &target.path;
    let mut document = read_document(path)?;
    let Some(servers) = document
        .get_mut(target.key)
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
    fn an_agent_without_an_mcp_client_is_reported_unsupported() {
        // Generic Shell is the only one left without any MCP surface; it must
        // say so instead of offering a switch that writes nowhere.
        let report = status(
            AgentType::Shell,
            &install(AgentType::Shell, "/bin/sh"),
            Path::new("/app/agentport-mcp"),
        );
        assert_eq!(report.state, RegistrationState::Unsupported);
        assert!(!report.detail.is_empty());
        assert!(!report.is_supported());
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
        // Qoder prefixes each row with a status glyph and a banner line above.
        let qoder = "Configured MCP servers:\n\n✓ agentport: /app/agentport-mcp serve --stdio (stdio) - Connected · Direct MCP Server\n";
        assert_eq!(
            parse_names(qoder, ListFormat::ColonLines).unwrap(),
            vec!["agentport".to_string()]
        );
        // A banner ("Configured MCP servers:") is not a server name.
        assert_eq!(parse_names(qoder, ListFormat::ColonLines).unwrap().len(), 1);
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

    fn target_at(path: &std::path::Path) -> JsonFileTarget {
        json_servers(path.to_path_buf())
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
        add_json_server(&target_at(&path), bin).unwrap();
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["theme"], "dark");
        assert_eq!(document["mcpServers"]["other"]["command"], "/bin/other");
        assert_eq!(document["mcpServers"]["agentport"]["args"][0], "serve");

        remove_json_server(&target_at(&path)).unwrap();
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
        let error =
            add_json_server(&target_at(&path), Path::new("/app/agentport-mcp")).unwrap_err();
        assert!(format!("{error}").contains("not valid JSON"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{oops");
    }

    #[test]
    fn a_foreign_entry_under_our_name_is_a_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        fs::write(&path, r#"{"mcpServers":{"agentport":{"command":"/somewhere/else"}}}"#).unwrap();
        let error =
            add_json_server(&target_at(&path), Path::new("/app/agentport-mcp")).unwrap_err();
        assert!(matches!(error, CoreError::Conflict(_)));
    }

    #[test]
    fn each_client_gets_its_own_entry_shape() {
        let bin = Path::new("/app/agentport-mcp");
        let plain = JsonFileTarget {
            path: PathBuf::from("/tmp/x"),
            key: "mcpServers",
            shape: JsonEntryShape::CommandArgs,
            blocker: None,
        };
        assert_eq!(
            server_entry(&plain, bin),
            serde_json::json!({"command": "/app/agentport-mcp", "args": ["serve", "--stdio"]})
        );
        // OpenCode: `type: local` and a command array.
        let opencode = JsonFileTarget {
            shape: JsonEntryShape::OpenCodeLocal,
            key: "mcp",
            ..plain.clone()
        };
        let entry = server_entry(&opencode, bin);
        assert_eq!(entry["type"], "local");
        assert_eq!(entry["command"][0], "/app/agentport-mcp");
        assert_eq!(entry["enabled"], true);
        // Cline: disabled/autoApprove are part of its schema.
        let cline = JsonFileTarget {
            shape: JsonEntryShape::ClineCommandArgs,
            ..plain.clone()
        };
        let entry = server_entry(&cline, bin);
        assert_eq!(entry["disabled"], false);
        assert_eq!(entry["autoApprove"], serde_json::json!([]));
    }

    #[test]
    fn a_second_client_config_keeps_its_own_key_and_neighbours() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(
            &path,
            r#"{"amp.mcpServers":{"other":{"command":"/bin/other"}},"theme":"dark"}"#,
        )
        .unwrap();
        let amp = JsonFileTarget {
            path: path.clone(),
            key: "amp.mcpServers",
            shape: JsonEntryShape::CommandArgs,
            blocker: None,
        };
        add_json_server(&amp, Path::new("/app/agentport-mcp")).unwrap();
        let document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // Amp's dotted key is written verbatim; a bare mcpServers is not invented.
        assert!(document["amp.mcpServers"].get("agentport").is_some());
        assert!(document.get("mcpServers").is_none());
        assert_eq!(document["theme"], "dark");
        assert_eq!(document["amp.mcpServers"]["other"]["command"], "/bin/other");
    }

    #[test]
    fn a_jsonc_sibling_blocks_the_write_instead_of_shadowing_it() {
        let dir = tempfile::tempdir().unwrap();
        let json = dir.path().join("opencode.json");
        fs::write(dir.path().join("opencode.jsonc"), "{\n // user config\n}\n").unwrap();
        let target = JsonFileTarget {
            path: json.clone(),
            key: "mcp",
            shape: JsonEntryShape::OpenCodeLocal,
            blocker: Some("opencode.jsonc"),
        };
        let reason = blocked_by_sibling(&target).unwrap();
        assert!(reason.contains("opencode.jsonc"));
        assert!(!json.exists(), "nothing is written when we refuse");
    }

    #[test]
    fn added_clients_report_a_configured_path() {
        for agent in [
            AgentType::Kimi,
            AgentType::Omp,
            AgentType::Gemini,
            AgentType::Opencode,
            AgentType::Amp,
            AgentType::Cline,
            AgentType::KiroCli,
        ] {
            let report = status(agent, &install(agent, "/bin/x"), Path::new("/app/agentport-mcp"));
            assert!(
                report.is_supported(),
                "{agent:?} must be supported now: {}",
                report.detail
            );
            assert!(!report.target.is_empty(), "{agent:?} must name its config file");
        }
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
