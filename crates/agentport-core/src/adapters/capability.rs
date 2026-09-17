//! CLI discovery + capability probing (PRD 3.1).
//!
//! Sources of PATH, in order: process env PATH, login shell PATH
//! (`$SHELL -l -c 'printf %s "$PATH"'` and `-i -l` fallback — GUI apps do not
//! inherit interactive shell PATH), then well-known install dirs. Every
//! candidate is retained, while probing automatically picks the first
//! compatible executable by that deterministic priority; a user may still
//! override it with an explicit path.
//!
//! Version probing is read-only (`--version`, then `--help` for capabilities),
//! with a hard 2 s timeout: on timeout the probe process is killed and the CLI
//! is marked Unavailable (PRD 3.1 failure path B).

use crate::error::{CoreError, Result};
use crate::models::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Budget for one read-only probe (`--version`, `--help`, …). Two seconds was
/// too tight: a loaded machine can exceed it for a trivial shell script (the
/// full test suite reproduced `Timeout("… --version exceeded 2s")`), and real
/// CLIs such as node-based `claude`/`pi` take seconds to boot cold — either
/// case wrongly reports a usable CLI as unavailable. The trade-off is bounded:
/// a hanging candidate costs up to this budget per probe.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Timeout for the login-shell PATH lookup (separate from the probe timeout).
pub const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_PROBE_OUTPUT: usize = 256 * 1024; // 256 KiB
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const MAX_VERSIONED_RUNTIME_DIRS: usize = 8;

#[derive(Debug, Clone)]
pub struct ProbeOutcome {
    pub agent_type: AgentType,
    pub state: ProbeState,
    pub install: Option<AdapterInstall>,
    pub candidates: Vec<ProbeCandidate>,
    /// Human-readable failure reason, or an automatic-selection note.
    pub reason: Option<String>,
    /// Stable renderer-facing message code. `reason` remains for older GUIs.
    pub reason_code: Option<&'static str>,
    /// Raw probe detail kept out of the localized display message.
    pub reason_detail: Option<String>,
}

/// Spawn `exe args...` with stdout/stderr piped, poll every 50 ms, kill the
/// child on `timeout` and return CoreError::Timeout. Combined output is
/// truncated to `max_bytes`.
fn spawn_capture(exe: &Path, args: &[&str], timeout: Duration, max_bytes: usize) -> Result<String> {
    spawn_capture_with_path(exe, args, timeout, max_bytes, None)
}

fn spawn_capture_with_path(
    exe: &Path,
    args: &[&str],
    timeout: Duration,
    max_bytes: usize,
    path_env: Option<&OsStr>,
) -> Result<String> {
    let mut command = Command::new(exe);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = path_env {
        command.env("PATH", path);
    }
    let mut child: Child = command
        .spawn()
        .map_err(|e| CoreError::Adapter(format!("spawn {}: {e}", exe.display())))?;

    // Drain pipes on threads so a chatty child never blocks on a full pipe.
    let mut out_buf: Vec<u8> = Vec::new();
    let mut err_buf: Vec<u8> = Vec::new();
    let stdout_thread = child.stdout.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });
    let stderr_thread = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if let Some(t) = stdout_thread {
                    out_buf = t.join().unwrap_or_default();
                }
                if let Some(t) = stderr_thread {
                    err_buf = t.join().unwrap_or_default();
                }
                out_buf.extend_from_slice(&err_buf);
                out_buf.truncate(max_bytes);
                if !status.success() {
                    return Err(CoreError::Adapter(format!(
                        "{} {} exited with {status}: {}",
                        exe.display(),
                        args.join(" "),
                        String::from_utf8_lossy(&out_buf)
                            .chars()
                            .take(200)
                            .collect::<String>()
                    )));
                }
                return Ok(String::from_utf8_lossy(&out_buf).into_owned());
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait(); // reap
                    return Err(CoreError::Timeout(format!(
                        "{} {} exceeded {:?}",
                        exe.display(),
                        args.join(" "),
                        timeout
                    )));
                }
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CoreError::Io(e));
            }
        }
    }
}

/// Run `exe --version` and `exe --help` with PROBE_TIMEOUT; kill on timeout.
/// Returns (version_text, help_text). Output truncated to 256 KiB each.
pub fn run_readonly_probe(exe: &Path) -> Result<(String, String)> {
    let path_env = effective_path_env();
    run_readonly_probe_with_path(exe, &path_env)
}

fn run_readonly_probe_with_path(exe: &Path, path_env: &OsStr) -> Result<(String, String)> {
    let version_raw = spawn_capture_with_path(
        exe,
        &["--version"],
        PROBE_TIMEOUT,
        MAX_PROBE_OUTPUT,
        Some(path_env),
    )?;
    let help = spawn_capture_with_path(
        exe,
        &["--help"],
        PROBE_TIMEOUT,
        MAX_PROBE_OUTPUT,
        Some(path_env),
    )?;
    // Version text = first line of `--version`; if empty, first line of `--help`.
    fn first_line(s: &str) -> &str {
        s.lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("")
    }
    let mut version = first_line(&version_raw).to_string();
    if version.is_empty() {
        version = first_line(&help).to_string();
    }
    Ok((version, help))
}

fn run_readonly_probe_for_agent(
    agent: AgentType,
    exe: &Path,
    path_env: &OsStr,
) -> Result<(String, String)> {
    let (version, mut help) = match run_readonly_probe_with_path(exe, path_env) {
        Err(CoreError::Timeout(_)) if agent == AgentType::Qoder => {
            run_readonly_probe_with_path(exe, path_env)
        }
        result => result,
    }?;
    // These CLIs put interactive/resume flags in subcommand help, not the
    // top-level help. Only append successfully probed read-only help; a
    // missing/old subcommand must never turn into assumed capabilities.
    let subcommand: &[&str] = match agent {
        AgentType::KiroCli => &["chat", "--help"],
        AgentType::Amp => &["threads", "continue", "--help"],
        _ => &[],
    };
    if !subcommand.is_empty() {
        if let Ok(extra) = spawn_capture_with_path(
            exe, subcommand, PROBE_TIMEOUT, MAX_PROBE_OUTPUT, Some(path_env),
        ) {
            help.push('\n');
            help.push_str(&extra);
        }
    }
    Ok((version, help))
}

/// sha256 over version+help — the capability snapshot identity.
pub fn capability_hash(version: &str, help: &str) -> String {
    let mut h = Sha256::new();
    h.update(version.as_bytes());
    h.update(help.as_bytes());
    let hex = format!("{:x}", h.finalize());
    format!("sha256:{}", &hex[..16])
}

fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

/// Pure core of candidate matching: keep existing executable files, dedupe by
/// canonical path (first occurrence wins). Order is preserved.
///
/// The STORED path is the original (non-canonicalized) one: package managers
/// like Homebrew point a stable symlink (`/opt/homebrew/bin/codex`) at a
/// versioned Cellar/Caskroom path that is deleted on upgrade. Persisting the
/// symlink keeps cached installs valid across upgrades; canonicalizing only
/// serves dedupe identity here.
pub fn find_candidates_in(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        if !is_executable_file(p) {
            continue;
        }
        let canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.clone());
        if seen.insert(canon.clone()) {
            out.push(p.clone());
        }
    }
    out
}

fn versioned_runtime_dirs(root: &Path, suffix: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path().join(suffix);
            path.is_dir().then(|| {
                let version = entry
                    .file_name()
                    .to_string_lossy()
                    .split(|character: char| !character.is_ascii_digit())
                    .filter_map(|part| part.parse::<u64>().ok())
                    .collect::<Vec<_>>();
                (version, path)
            })
        })
        .collect::<Vec<_>>();
    dirs.sort_by(|(a_version, a_path), (b_version, b_path)| {
        b_version.cmp(a_version).then_with(|| b_path.cmp(a_path))
    });
    dirs.into_iter()
        .take(MAX_VERSIONED_RUNTIME_DIRS)
        .map(|(_, path)| path)
        .collect()
}

/// Fallback install directories that desktop apps commonly miss. Stable
/// version-manager aliases precede versioned installations; the latter are
/// sorted newest-version-first and still have to pass the read-only probe.
fn discovery_dirs() -> Vec<(PathBuf, &'static str)> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for relative in [
            ".volta/bin",
            ".asdf/shims",
            ".local/share/mise/shims",
            ".local/share/fnm/aliases/default/bin",
            ".local/share/pnpm",
            ".bun/bin",
            ".npm-global/bin",
        ] {
            dirs.push((home.join(relative), "version_manager"));
        }
        for path in versioned_runtime_dirs(
            &home.join(".local/share/fnm/node-versions"),
            Path::new("installation/bin"),
        ) {
            dirs.push((path, "version_manager"));
        }
        for path in versioned_runtime_dirs(&home.join(".nvm/versions/node"), Path::new("bin")) {
            dirs.push((path, "version_manager"));
        }
        for relative in [
            ".local/bin", ".cargo/bin", ".kimi-code/bin", ".claude/bin",
            ".opencode/bin", ".amp/bin", ".grok/bin",
        ] {
            dirs.push((home.join(relative), "well_known_dir"));
        }
    }
    for path in [
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/opt/local/bin",
        "/snap/bin",
    ] {
        dirs.push((PathBuf::from(path), "well_known_dir"));
    }
    dirs
}

fn process_path_entries() -> Vec<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect()
}

/// PATH entries from the user's interactive-login shell. Version managers such
/// as nvm/fnm are commonly initialized only by interactive rc files, so prefer
/// `-i -l`; fall back to `-l` for shells that reject interactive mode.
fn login_shell_path_entries() -> Vec<PathBuf> {
    const PATH_MARKER: &str = "__AGENTPORT_PATH__=";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    for flags in [&["-i", "-l"][..], &["-l"][..]] {
        let mut args: Vec<&str> = flags.to_vec();
        args.extend(["-c", "printf '\\n__AGENTPORT_PATH__=%s\\n' \"$PATH\""]);
        if let Ok(out) = spawn_capture(Path::new(&shell), &args, LOGIN_SHELL_TIMEOUT, 16_384) {
            let Some(path_value) = out.lines().find_map(|line| line.strip_prefix(PATH_MARKER))
            else {
                continue;
            };
            let mut entries = Vec::new();
            for entry in path_value
                .split(':')
                .filter(|entry| !entry.is_empty())
                .map(PathBuf::from)
            {
                if !entries.contains(&entry) {
                    entries.push(entry);
                }
            }
            if !entries.is_empty() {
                return entries;
            }
        }
    }
    Vec::new()
}

const LOGIN_ENV_MARKER: &str = "__AGENTPORT_ENV__=";

fn parse_login_shell_environment(output: &str) -> Vec<(String, String)> {
    let mut values = BTreeMap::new();
    for payload in output
        .lines()
        .filter_map(|line| line.strip_prefix(LOGIN_ENV_MARKER))
    {
        let Some((name, value)) = payload.split_once('=') else {
            continue;
        };
        values.insert(name.to_string(), value.to_string());
    }
    values.into_iter().collect()
}

/// Full launch environment sourced from the process and the user's
/// interactive login shell. No variable filtering: session Agents inherit
/// the same environment a terminal would provide, including proxy variables
/// (HTTPS_PROXY et al. — GUI apps do not read macOS system proxy settings)
/// and any credentials the user exports in shell rc files.
pub fn login_shell_launch_environment() -> Vec<(String, String)> {
    let mut values = BTreeMap::new();
    values.extend(std::env::vars());

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let script =
        "env | while IFS= read -r line; do printf '__AGENTPORT_ENV__=%s\\n' \"$line\"; done";
    for flags in [&["-i", "-l"][..], &["-l"][..]] {
        let mut args: Vec<&str> = flags.to_vec();
        args.extend(["-c", script]);
        if let Ok(output) = spawn_capture(
            Path::new(&shell),
            &args,
            LOGIN_SHELL_TIMEOUT,
            MAX_PROBE_OUTPUT,
        ) {
            for (name, value) in parse_login_shell_environment(&output) {
                values.insert(name, value);
            }
            break;
        }
    }
    values.into_iter().collect()
}

/// Collect candidate executables from explicit process and login-shell PATH
/// sources. Each source keeps its own priority label for diagnostics.
fn find_candidates_from_paths(
    t: AgentType,
    process_paths: &[PathBuf],
    login_paths: &[PathBuf],
    discovery_paths: &[(PathBuf, &'static str)],
) -> Vec<ProbeCandidate> {
    // (path, source) in priority order; first occurrence of a canonical path wins.
    let mut raw: Vec<(PathBuf, &str)> = Vec::new();
    for name in t.command_names() {
        for dir in login_paths {
            raw.push((dir.join(name), "login_shell_path"));
        }
        for dir in process_paths {
            raw.push((dir.join(name), "system_path"));
        }
        for (dir, source) in discovery_paths {
            raw.push((dir.join(name), *source));
        }
    }
    let existing = find_candidates_in(&raw.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>());
    // Map back to the first source label for each canonical path.
    let mut out = Vec::new();
    for stored in existing {
        let stored_canon = std::fs::canonicalize(&stored).unwrap_or_else(|_| stored.clone());
        let source = raw
            .iter()
            .find(|(p, _)| {
                is_executable_file(p)
                    && std::fs::canonicalize(p).unwrap_or_else(|_| p.clone()) == stored_canon
            })
            .map(|(_, s)| *s)
            .unwrap_or("system_path");
        out.push(ProbeCandidate {
            path: stored.to_string_lossy().into_owned(),
            version_text: None,
            source: source.to_string(),
        });
    }
    out
}

/// Collect candidate executables for one agent type from all PATH sources.
pub fn find_candidates(t: AgentType) -> Vec<ProbeCandidate> {
    find_candidates_from_paths(
        t,
        &process_path_entries(),
        &login_shell_path_entries(),
        &discovery_dirs(),
    )
}

fn probe_install(
    t: AgentType,
    exe: &Path,
    candidates: &[ProbeCandidate],
    path_env: &OsStr,
) -> Result<AdapterInstall> {
    let adapter = super::adapter_for(t);
    let probed = run_readonly_probe_for_agent(t, exe, path_env);
    // Shell fallback: /bin/sh may be dash (no --version/--help). A shell
    // that merely exists and is executable is usable — mark it Available
    // with an "unknown" version instead of Unavailable (PRD 3.1: 降级不阻塞).
    if t == AgentType::Shell {
        if let Err(e) = &probed {
            let mut install = adapter.parse_capabilities(exe, "unknown (no --version)", "")?;
            install.candidates = candidates.to_vec();
            install.version_text = format!("unknown ({e})");
            return Ok(install);
        }
    }
    let (version, mut help) = probed?;
    // Codex keeps resume flags in a subcommand; merge its help so
    // parse_capabilities sees the full surface (still read-only).
    if t == AgentType::Codex {
        if let Ok(sub) = spawn_capture_with_path(
            exe,
            &["resume", "--help"],
            PROBE_TIMEOUT,
            MAX_PROBE_OUTPUT,
            Some(path_env),
        ) {
            help.push('\n');
            help.push_str(&sub);
        }
    }
    let mut install = adapter.parse_capabilities(exe, &version, &help)?;
    install.candidates = candidates.to_vec();
    Ok(install)
}

fn probe_agent_with_candidates(
    t: AgentType,
    confirmed_path: Option<&Path>,
    mut candidates: Vec<ProbeCandidate>,
    path_env: &OsStr,
) -> ProbeOutcome {
    let mk =
        |state, install, reason, reason_code, reason_detail, candidates: Vec<ProbeCandidate>| {
            ProbeOutcome {
                agent_type: t,
                state,
                install,
                candidates,
                reason,
                reason_code,
                reason_detail,
            }
        };

    if let Some(path) = confirmed_path {
        let manual_path = path.to_string_lossy().into_owned();
        let known = candidates
            .iter()
            .any(|candidate| candidate.path == manual_path);
        if !known {
            candidates.insert(
                0,
                ProbeCandidate {
                    path: manual_path,
                    version_text: None,
                    source: "manual".into(),
                },
            );
        }
        let selected = PathBuf::from(&path);
        return match probe_install(t, &selected, &candidates, path_env) {
            Ok(mut install) => {
                if let Some(candidate) = candidates
                    .iter_mut()
                    .find(|candidate| candidate.path == selected.to_string_lossy())
                {
                    candidate.version_text = Some(install.version_text.clone());
                }
                install.candidates = candidates.clone();
                mk(
                    ProbeState::Available,
                    Some(install),
                    None,
                    None,
                    None,
                    candidates,
                )
            }
            Err(error) => {
                let detail = error.to_string();
                mk(
                    ProbeState::Unavailable,
                    None,
                    Some(format!("探测失败: {detail}")),
                    Some("probe_failed"),
                    Some(detail),
                    candidates,
                )
            }
        };
    }

    if candidates.is_empty() {
        return mk(
            ProbeState::Unavailable,
            None,
            Some("未找到可执行文件".into()),
            Some("probe_executable_not_found"),
            None,
            candidates,
        );
    }

    let total = candidates.len();
    let mut errors = Vec::new();
    for index in 0..total {
        let exe = PathBuf::from(&candidates[index].path);
        match probe_install(t, &exe, &candidates, path_env) {
            Ok(mut install) => {
                candidates[index].version_text = Some(install.version_text.clone());
                install.candidates = candidates.clone();
                let note = (total > 1).then(|| {
                    format!(
                        "已从 {total} 个候选中自动选择优先级最高且可用的路径；可在下方指定其他路径。"
                    )
                });
                return mk(
                    ProbeState::Available,
                    Some(install),
                    note,
                    (total > 1).then_some("probe_auto_selected"),
                    None,
                    candidates,
                );
            }
            Err(error) => errors.push(format!("{}: {error}", exe.display())),
        }
    }

    let detail = errors
        .into_iter()
        .next()
        .unwrap_or_else(|| "未知错误".into());
    mk(
        ProbeState::Unavailable,
        None,
        Some(format!(
            "发现 {total} 个候选，但均无法通过只读探测：{detail}"
        )),
        Some("probe_candidates_failed"),
        Some(detail),
        candidates,
    )
}

/// Full probe for one agent type. Without an explicit path, every discovered
/// candidate remains visible and is tried in deterministic priority order.
pub fn probe_agent(t: AgentType, confirmed_path: Option<&Path>) -> ProbeOutcome {
    let process_paths = process_path_entries();
    let login_paths = login_shell_path_entries();
    let discovery_paths = discovery_dirs();
    let path_env = effective_path_env_from(&process_paths, &login_paths, &discovery_paths);
    probe_agent_with_candidates(
        t,
        confirmed_path,
        find_candidates_from_paths(t, &process_paths, &login_paths, &discovery_paths),
        &path_env,
    )
}

pub fn probe_all() -> Vec<ProbeOutcome> {
    probe_all_with_confirmed_paths(&[])
}

/// Probe every adapter while retaining explicit executable selections for the
/// listed agent types. Environment discovery is shared across the batch so a
/// startup refresh does not invoke the login shell once per adapter.
pub fn probe_all_with_confirmed_paths(
    confirmed_paths: &[(AgentType, PathBuf)],
) -> Vec<ProbeOutcome> {
    let process_paths = process_path_entries();
    let login_paths = login_shell_path_entries();
    let discovery_paths = discovery_dirs();
    let path_env = effective_path_env_from(&process_paths, &login_paths, &discovery_paths);
    AgentType::all()
        .iter()
        .copied()
        .map(|t| {
            let confirmed_path = confirmed_paths
                .iter()
                .find_map(|(agent, path)| (*agent == t).then_some(path.as_path()));
            probe_agent_with_candidates(
                t,
                confirmed_path,
                find_candidates_from_paths(t, &process_paths, &login_paths, &discovery_paths),
                &path_env,
            )
        })
        .collect()
}

fn effective_path_entries_from(
    process_paths: &[PathBuf],
    login_paths: &[PathBuf],
    discovery_paths: &[(PathBuf, &'static str)],
) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for paths in [login_paths, process_paths] {
        for path in paths {
            if !out.contains(path) {
                out.push(path.clone());
            }
        }
    }
    for (path, _) in discovery_paths {
        if !out.contains(path) {
            out.push(path.clone());
        }
    }
    out
}

fn effective_path_env_from(
    process_paths: &[PathBuf],
    login_paths: &[PathBuf],
    discovery_paths: &[(PathBuf, &'static str)],
) -> OsString {
    std::env::join_paths(effective_path_entries_from(
        process_paths,
        login_paths,
        discovery_paths,
    ))
    .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// PATH used for Agent discovery, read-only probes, and Session launches.
pub fn effective_path_entries() -> Vec<PathBuf> {
    effective_path_entries_from(
        &process_path_entries(),
        &login_shell_path_entries(),
        &discovery_dirs(),
    )
}

pub fn effective_path_env() -> OsString {
    std::env::join_paths(effective_path_entries())
        .unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

pub fn merge_path_env(env: &mut Vec<(String, String)>, effective_paths: &[PathBuf]) -> Result<()> {
    let mut merged = Vec::new();
    for (_, value) in env.iter().filter(|(name, _)| name == "PATH") {
        for path in std::env::split_paths(value) {
            if !merged.contains(&path) {
                merged.push(path);
            }
        }
    }
    for path in effective_paths {
        if !merged.contains(path) {
            merged.push(path.clone());
        }
    }
    let value = std::env::join_paths(merged)
        .map_err(|error| CoreError::Validation(format!("cannot build Agent PATH: {error}")))?
        .to_string_lossy()
        .into_owned();
    env.retain(|(name, _)| name != "PATH");
    env.push(("PATH".into(), value));
    Ok(())
}

/// Complete an already-captured login-shell environment with process and
/// discovery paths. The shell PATH is already in `env`; probing it again would
/// launch the same interactive login shell twice for every Session start.
/// Do not cache the snapshot: rc-file/environment changes apply on the next run.
pub fn merge_launch_path_env(env: &mut Vec<(String, String)>) -> Result<()> {
    merge_path_env(
        env,
        &effective_path_entries_from(&process_path_entries(), &[], &discovery_dirs()),
    )
}

pub fn merge_effective_path_env(env: &mut Vec<(String, String)>) -> Result<()> {
    merge_path_env(env, &effective_path_entries())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    const CLAUDE: &str = "/Users/w/.local/bin/claude";

    #[test]
    fn login_shell_launch_env_keeps_full_shell_environment() {
        let parsed = parse_login_shell_environment(
            "__AGENTPORT_ENV__=EDITOR=nvim\n\
             __AGENTPORT_ENV__=SSH_AUTH_SOCK=/tmp/agent.sock\n\
             __AGENTPORT_ENV__=OPENAI_API_KEY=secret\n\
             __AGENTPORT_ENV__=HTTP_PROXY=http://user:password@proxy\n",
        );
        assert!(parsed
            .iter()
            .any(|(name, value)| name == "EDITOR" && value == "nvim"));
        assert!(parsed
            .iter()
            .any(|(name, value)| name == "SSH_AUTH_SOCK" && value == "/tmp/agent.sock"));
        // No filtering: proxy URLs and credentials from the login shell are
        // inherited so Agents see the same environment as a terminal.
        assert!(parsed
            .iter()
            .any(|(name, value)| name == "OPENAI_API_KEY" && value == "secret"));
        assert!(parsed.iter().any(|(name, value)| name == "HTTP_PROXY"
            && value == "http://user:password@proxy"));
    }
    #[test]
    fn captured_launch_path_preserves_login_and_overlay_priority() {
        let mut env = vec![
            ("PATH".into(), "/fixture/login:/fixture/shared".into()),
            ("PATH".into(), "/fixture/overlay:/fixture/shared".into()),
            ("EDITOR".into(), "fixture-editor".into()),
        ];
        merge_launch_path_env(&mut env).unwrap();
        let paths: Vec<_> =
            std::env::split_paths(&env.iter().find(|(name, _)| name == "PATH").unwrap().1).collect();
        assert_eq!(
            &paths[..3],
            &[
                PathBuf::from("/fixture/login"),
                PathBuf::from("/fixture/shared"),
                PathBuf::from("/fixture/overlay"),
            ]
        );
        assert!(process_path_entries().iter().all(|p| paths.contains(p)));
        assert!(discovery_dirs().iter().all(|(p, _)| paths.contains(p)));
        assert_eq!(env.iter().filter(|(name, _)| name == "PATH").count(), 1);
        assert!(env.contains(&("EDITOR".into(), "fixture-editor".into())));
    }

    const CODEX: &str = "/Users/w/.local/bin/codex";
    const KIMI: &str = "/Users/w/.kimi-code/bin/kimi";
    const QODER: &str = "/Users/w/.local/bin/qodercli";
    const PI: &str = "/Users/w/.local/state/fnm_multishells/8620_1784730418362/bin/pi";

    fn write_exe(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, body).unwrap();
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&p, perms).unwrap();
        p
    }

    #[test]
    fn capability_hash_format() {
        let h = capability_hash("v1", "help");
        assert!(h.starts_with("sha256:"));
        assert_eq!(h.len(), "sha256:".len() + 16);
        assert!(h[7..].chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(capability_hash("v1", "help"), capability_hash("v2", "help"));
    }

    #[test]
    fn readonly_probe_reads_version_first_line_and_help() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = write_exe(
            tmp.path(),
            "fakecli",
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'fake 1.2.3'; else echo 'usage: fake'; echo '  --foo  bar'; fi\n",
        );
        let (version, help) = run_readonly_probe(&exe).unwrap();
        assert_eq!(version, "fake 1.2.3");
        assert!(help.contains("--foo"));
    }

    #[test]
    fn readonly_probe_timeout_kills_child() {
        let tmp = tempfile::tempdir().unwrap();
        let marker = tmp.path().join("finished");
        let exe = write_exe(
            tmp.path(),
            "slowcli",
            &format!("#!/bin/sh\nsleep 10\ntouch {}\n", marker.display()),
        );
        let start = Instant::now();
        let err = run_readonly_probe(&exe).unwrap_err();
        let elapsed = start.elapsed();
        assert!(matches!(err, CoreError::Timeout(_)), "got {err:?}");
        // PROBE_TIMEOUT 即返回，远小于脚本的 10s；留出负载余量
        assert!(
            elapsed < PROBE_TIMEOUT + Duration::from_secs(3),
            "elapsed {elapsed:?}"
        );
        // 子进程已被 kill+reap：按唯一路径 pgrep 不应有残留
        let out = Command::new("pgrep")
            .args(["-f", exe.to_str().unwrap()])
            .output()
            .unwrap();
        assert!(
            out.stdout.is_empty(),
            "probe child still running: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }

    #[test]
    fn qoder_probe_retries_one_cold_start_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let first_help = tmp.path().join("first-help");
        let exe = write_exe(
            tmp.path(),
            "qodercli",
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"--version\" ]; then echo '1.1.5'; exit 0; fi\n\
                 if [ ! -f '{}' ]; then touch '{}'; sleep 10; fi\n\
                 echo 'Usage: qodercli [options]'\n",
                first_help.display(),
                first_help.display(),
            ),
        );
        let path_env = effective_path_env();
        let start = Instant::now();

        let (version, help) =
            run_readonly_probe_for_agent(AgentType::Qoder, &exe, &path_env).unwrap();

        assert_eq!(version, "1.1.5");
        assert!(help.contains("Usage: qodercli"));
        // One cold-start timeout plus the successful retry, with slack for load.
        assert!(
            start.elapsed() < PROBE_TIMEOUT + Duration::from_secs(3),
            "cold-start retry took {:?}",
            start.elapsed()
        );
    }

    #[test]
    fn new_subcommand_probes_expose_only_successful_capabilities() {
        let tmp = tempfile::tempdir().unwrap();
        for (agent, command, sub_help) in [
            (AgentType::KiroCli, "chat --help", "Usage: kiro-cli chat [OPTIONS]\\n--resume-id ID --resume"),
            (AgentType::Amp, "threads continue --help", "Usage: amp threads continue [threadId]"),
        ] {
            for succeeds in [true, false] {
                let exe = write_exe(tmp.path(), agent.as_str(), &format!(
                    "#!/bin/sh\ncase \"$*\" in\n--version) echo 'test 1.0';;\n--help) echo 'Root help';;\n'{command}') printf '{sub_help}\\n'; exit {};;\n*) exit 1;;\nesac\n",
                    if succeeds { 0 } else { 1 }
                ));
                let (version, help) = run_readonly_probe_for_agent(agent, &exe, OsStr::new("/usr/bin:/bin")).unwrap();
                let install = super::super::adapter_for(agent).parse_capabilities(&exe, &version, &help).unwrap();
                assert_eq!(install.exact_resume, succeeds, "{agent:?}: {help}");
                assert!(help.contains("Root help"));
                if !succeeds {
                    assert!(!help.contains("resume-id"));
                    assert!(!help.contains("threads continue"));
                }
            }
        }
    }

    #[test]
    fn find_candidates_in_dedupes_and_filters() {
        let tmp1 = tempfile::tempdir().unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        let a = write_exe(tmp1.path(), "same-name", "#!/bin/sh\nexit 0\n");
        let b = write_exe(tmp2.path(), "same-name", "#!/bin/sh\nexit 0\n");
        let not_exe = tmp1.path().join("not-exe");
        std::fs::write(&not_exe, "#!/bin/sh\n").unwrap(); // 无执行位
        let missing = tmp1.path().join("missing");

        // 两个 tempdir 各放同名假 exe -> 2 候选
        let found = find_candidates_in(&[a.clone(), b.clone()]);
        assert_eq!(found.len(), 2);
        // 重复路径去重；不可执行/不存在被过滤
        let found = find_candidates_in(&[a.clone(), a.clone(), not_exe, missing]);
        assert_eq!(found, vec![a]);
    }

    #[test]
    fn find_candidates_in_keeps_stable_symlink_path() {
        // Homebrew 场景：/opt/homebrew/bin/<name> 是指向版本化目录的符号链接，
        // 升级后版本化路径失效而符号链接仍有效。去重按 canonical 进行，
        // 但存库的必须是第一个出现的原始（符号链接）路径。
        let tmp = tempfile::tempdir().unwrap();
        let real = write_exe(tmp.path(), "real-bin", "#!/bin/sh\nexit 0\n");
        let link = tmp.path().join("link-bin");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let found = find_candidates_in(&[link.clone(), real.clone()]);
        assert_eq!(found, vec![link]);
        // 反向顺序：真实路径先出现则保留真实路径，符号链接被去重。
        let found = find_candidates_in(&[real.clone(), tmp.path().join("link-bin")]);
        assert_eq!(found, vec![real]);
    }

    #[test]
    fn automatic_probe_skips_bad_candidates_without_hiding_them() {
        let tmp = tempfile::tempdir().unwrap();
        let path_env = effective_path_env();
        let bad = write_exe(tmp.path(), "bad-claude", "#!/bin/sh\nexit 1\n");
        let usable = write_exe(
            tmp.path(),
            "usable-claude",
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'Claude 9.9.9'; else echo '--session-id --resume --settings'; fi\n",
        );
        let outcome = probe_agent_with_candidates(
            AgentType::Claude,
            None,
            vec![
                ProbeCandidate {
                    path: bad.to_string_lossy().into_owned(),
                    version_text: None,
                    source: "system_path".into(),
                },
                ProbeCandidate {
                    path: usable.to_string_lossy().into_owned(),
                    version_text: None,
                    source: "login_shell_path".into(),
                },
            ],
            &path_env,
        );

        assert_eq!(
            outcome.state,
            ProbeState::Available,
            "usable candidate was not selected: reason={:?} detail={:?}",
            outcome.reason,
            outcome.reason_detail
        );
        assert_eq!(
            outcome.install.as_ref().unwrap().executable_path,
            usable.to_string_lossy()
        );
        assert_eq!(outcome.candidates.len(), 2);
        assert!(outcome.reason.unwrap().contains("2 个候选"));
    }

    #[test]
    #[ignore = "requires user-installed agent CLIs"]
    fn probe_real_clis_available() {
        for (t, path) in [
            (AgentType::Claude, CLAUDE),
            (AgentType::Codex, CODEX),
            (AgentType::Kimi, KIMI),
            (AgentType::Qoder, QODER),
            (AgentType::Pi, PI),
        ] {
            if !Path::new(path).exists() {
                eprintln!("skip {path}: not installed");
                continue;
            }
            let outcome = probe_agent(t, Some(Path::new(path)));
            assert_eq!(
                outcome.state,
                ProbeState::Available,
                "{t:?} probe failed: {:?}",
                outcome.reason
            );
            let install = outcome.install.unwrap();
            assert_eq!(install.executable_path, path);
            assert!(!install.version_text.is_empty());
            assert!(install.capability_hash.starts_with("sha256:"));
        }
    }

    #[test]
    fn probe_zero_candidates_unavailable() {
        // 用一个本机必不存在的 agent 命令名不可行，直接构造逻辑验证：
        // find_candidates 对 shell 至少有结果——此处只验证 Unavailable 分支的 reason 语义，
        // 通过 confirmed_path 指向不存在文件触发 Adapter 错误。
        let outcome = probe_agent(AgentType::Claude, Some(Path::new("/nonexistent/cli")));
        assert_eq!(outcome.state, ProbeState::Unavailable);
        assert!(outcome.reason.unwrap().contains("探测失败"));
    }
}
