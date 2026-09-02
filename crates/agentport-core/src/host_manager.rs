//! Host lifecycle manager (PRD 3.3, ch.6).
//!
//! The GUI/CLI never owns agent processes. This module spawns one
//! `agentport-host` process per session, hands it a HostConfig via a 0600
//! config file (no secrets — secrets go through the spawn environment only),
//! and speaks the handshake-verified socket protocol. Reconnects validate
//! session id + token every time; stale sockets are removed, never written to.

use crate::db::{Db, SessionHostBinding};
use crate::error::{CoreError, Result};
use crate::ids;
use crate::models::*;
use crate::paths::AppPaths;
use crate::protocol::*;
use crate::secrets::SecretValue;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
pub const SPAWN_READY_TIMEOUT: Duration = Duration::from_secs(10);
const UNREACHABLE_STOP_RECONCILE_TIMEOUT: Duration = Duration::from_millis(500);
const UNREACHABLE_STOP_RECONCILE_POLL: Duration = Duration::from_millis(25);

/// HostConfig defaults (mirror protocol.rs serde defaults, which are private).
const DEFAULT_SIGINT_GRACE_MS: u64 = 1_500;
const DEFAULT_SIGTERM_GRACE_MS: u64 = 2_500;
const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 32;

/// Locate the agentport-host binary: $AGENTPORT_HOST_BIN, else next to the
/// current executable, else PATH lookup.
pub fn host_binary_path() -> Result<PathBuf> {
    // An explicitly configured path must be valid — silently falling back
    // would hide a misconfiguration (and makes the failure untestable).
    if let Ok(p) = std::env::var("AGENTPORT_HOST_BIN") {
        let pb = PathBuf::from(&p);
        if is_executable(&pb) {
            return Ok(pb);
        }
        return Err(CoreError::Host(format!(
            "AGENTPORT_HOST_BIN is not an executable file: {p}"
        )));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let cand = dir.join("agentport-host");
            if is_executable(&cand) {
                return Ok(cand);
            }
            // macOS bundle: sidecars land in Contents/MacOS, resources in
            // Contents/Resources — check both naming variants.
            if let Some(contents) = dir.parent() {
                let res = contents.join("Resources").join("agentport-host");
                if is_executable(&res) {
                    return Ok(res);
                }
                // Linux system install: /usr/bin/agentport ->
                // /usr/lib/agentport/agentport-host.
                let lib = contents
                    .join("lib")
                    .join("agentport")
                    .join("agentport-host");
                if is_executable(&lib) {
                    return Ok(lib);
                }
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("agentport-host");
            if is_executable(&cand) {
                return Ok(cand);
            }
        }
    }
    Err(CoreError::Host(
        "agentport-host binary not found (set AGENTPORT_HOST_BIN, or install it next to the app binary or on PATH)".into(),
    ))
}

/// Regular file with at least one executable bit set.
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(p) {
        Ok(m) => m.is_file() && m.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

fn io_host(context: &str) -> impl Fn(std::io::Error) -> CoreError + '_ {
    move |e| CoreError::Host(format!("{context}: {e}"))
}

/// Write host.json with mode 0600. The config NEVER contains secret values
/// (PRD 3.7) — only `secret_env_names`.
fn write_host_config(path: &Path, cfg: &HostConfig) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(serde_json::to_string_pretty(cfg)?.as_bytes())?;
    Ok(())
}

/// Last `max_bytes` of a log file, for error messages. Missing file -> "".
fn read_log_tail(path: &Path, max_bytes: usize) -> String {
    let Ok(bytes) = std::fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

/// A Host writes this file atomically enough for reconciliation purposes when
/// it completes its own stop/natural-exit flow.  It is a stronger terminal
/// fact than a missing socket: the GUI may have been closed while the Host
/// exited cleanly, so classifying that Session as Interrupted would be false.
fn terminal_lifecycle_from_host_state(
    paths: &AppPaths,
    session_id: &str,
    expected_host_pid: i64,
    expected_run: Option<(&str, i64)>,
) -> Option<Lifecycle> {
    if expected_host_pid <= 0 {
        return None;
    }
    let path = paths.session_dir(session_id).join("host-state.json");
    let value: serde_json::Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    if value.get("exited_at").is_none()
        || value.get("session_id").and_then(|v| v.as_str()) != Some(session_id)
        || value.get("host_pid").and_then(|v| v.as_i64()) != Some(expected_host_pid)
    {
        return None;
    }
    if let Some((run_id, run_ordinal)) = expected_run {
        if value.get("run_id").and_then(|v| v.as_str()) != Some(run_id)
            || value.get("run_ordinal").and_then(|v| v.as_i64()) != Some(run_ordinal)
        {
            return None;
        }
    }
    match value.get("exit_reason").and_then(|v| v.as_str()) {
        Some("user_stop") => Some(Lifecycle::Stopped),
        _ => Some(Lifecycle::Exited),
    }
}

/// True while `pid` exists (kill(pid, 0) succeeds or fails with EPERM).
fn pid_alive(pid: i32) -> bool {
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Ok(()) => true,
        Err(nix::errno::Errno::ESRCH) => false,
        Err(_) => true,
    }
}

fn stopped_run_is_group_cleaned(
    paths: &AppPaths,
    session_id: &str,
    expected_host_pid: i64,
    expected_run: Option<(&str, i64)>,
) -> bool {
    let path = paths.session_dir(session_id).join("host-state.json");
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    if value.get("session_id").and_then(|value| value.as_str()) != Some(session_id)
        || value.get("host_pid").and_then(|value| value.as_i64()) != Some(expected_host_pid)
        || value.get("exit_reason").and_then(|value| value.as_str()) != Some("user_stop")
        || value.get("group_cleaned").and_then(|value| value.as_bool()) != Some(true)
    {
        return false;
    }
    match expected_run {
        None => true,
        Some((run_id, run_ordinal)) => {
            value.get("run_id").and_then(|value| value.as_str()) == Some(run_id)
                && value.get("run_ordinal").and_then(|value| value.as_i64()) == Some(run_ordinal)
        }
    }
}

fn stop_is_complete(lifecycle: Lifecycle) -> bool {
    matches!(
        lifecycle,
        Lifecycle::Interrupted | Lifecycle::Exited | Lifecycle::Stopped
    )
}

/// Poll until `pid` is gone or `timeout` elapses. Returns true when gone.
fn wait_pid_gone(pid: i32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !pid_alive(pid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[derive(Debug)]
pub struct LaunchSpec {
    pub session: Session,
    /// argv from the adapter's LaunchPlan.
    pub command: Vec<String>,
    /// Non-secret env (inherited names + adapter plan env).
    pub env: Vec<(String, String)>,
    /// Secret env: passed ONLY via the host's spawn environment.
    pub secrets: Vec<(String, SecretValue)>,
    pub log_limit_bytes: u64,
    pub agent_session_id_hint: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone)]
pub struct AttachInfo {
    pub session_id: String,
    pub protocol: u32,
    pub host_pid: u32,
    pub child_alive: bool,
    pub log_bytes: u64,
    pub agent_session_id: Option<String>,
    pub run_id: String,
    pub run_ordinal: i64,
    pub current_status: Option<StatusEvent>,
    pub log_cursor: LogCursor,
    /// Additive Host features negotiated by presence in `HelloOk`.
    pub features: Vec<String>,
    pub terminal_geometry: Option<TerminalGeometry>,
}

pub struct HostManager<'a> {
    pub paths: &'a AppPaths,
    pub db: &'a Db,
}

impl<'a> HostManager<'a> {
    /// Write host.json (0600), spawn host with secrets in its env, wait for the
    /// socket + a verified handshake, mark session running. On ANY failure the
    /// host process is killed, the config removed, and the session marked
    /// exited-with-error — "Session 未启动；没有后台进程被保留" (PRD 7.4).
    /// Launch a host for a session. On success the host is handed to a
    /// detached reaper thread (no zombie accumulation while the GUI lives;
    /// the reaper also reconciles the lifecycle when the host dies without
    /// a client watching — host crash -> interrupted, clean exit -> exited).
    pub fn launch(&self, spec: LaunchSpec) -> Result<AttachInfo> {
        let session = spec.session;
        let id = session.id.clone();
        // A stable Session may be restarted many times. Reserve the run before
        // writing host.json so every Host-side fact has a durable namespace
        // even though its local state sequence starts at one.
        let run = self.db.create_session_run(&id, &ids::new_uuid())?;
        let run_log_path = self.paths.run_log_path(&id, &run.run_id);
        let run_log_path_str = run_log_path.to_string_lossy().into_owned();
        // Claim this generation before touching the socket or spawning. The
        // claim is the ownership fence for failures that occur before a PID is
        // available, and prevents an old reaper from terminally updating this
        // Session during replacement startup.
        self.db
            .claim_session_run(&id, &run.run_id, run.run_ordinal, &run_log_path_str)?;
        let socket_path = self.paths.socket_path(&id);
        let socket_str = socket_path.to_string_lossy().into_owned();
        let config_path = self.paths.host_config_path(&id);
        let mut child: Option<Child> = None;
        let mut bound_host_pid: Option<i64> = None;

        let mut launch_run = || -> Result<AttachInfo> {
            // Remove any stale socket file from a previous, dead host so the
            // new host can bind (a live host would never be re-launched).
            let _ = std::fs::remove_file(&socket_path);

            let bin = host_binary_path()?;

            let cfg = HostConfig {
                protocol: PROTOCOL_VERSION,
                session_id: id.clone(),
                run_id: run.run_id.clone(),
                run_ordinal: run.run_ordinal,
                host_token: session.host_token.clone(),
                command: spec.command.clone(),
                cwd: session.cwd.clone(),
                env: spec.env.clone(),
                adapter_type: session.adapter_type.as_str().to_string(),
                transport: session.transport,
                socket_path: socket_str.clone(),
                session_dir: self.paths.session_dir(&id).to_string_lossy().into_owned(),
                log_path: run_log_path_str.clone(),
                host_log_path: self.paths.host_log_path(&id).to_string_lossy().into_owned(),
                hook_events_path: self
                    .paths
                    .hook_events_path(&id)
                    .to_string_lossy()
                    .into_owned(),
                log_limit_bytes: spec.log_limit_bytes,
                agent_session_id_hint: spec.agent_session_id_hint.clone(),
                secret_env_names: spec.secrets.iter().map(|(n, _)| n.clone()).collect(),
                sigint_grace_ms: DEFAULT_SIGINT_GRACE_MS,
                sigterm_grace_ms: DEFAULT_SIGTERM_GRACE_MS,
                cols: if spec.cols > 0 {
                    spec.cols
                } else {
                    DEFAULT_COLS
                },
                rows: if spec.rows > 0 {
                    spec.rows
                } else {
                    DEFAULT_ROWS
                },
            };
            cfg.validate()?;
            write_host_config(&config_path, &cfg)?;

            let mut cmd = std::process::Command::new(&bin);
            cmd.arg("--config")
                .arg(&config_path)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            // Secrets travel ONLY through the spawn environment. The rest of
            // the parent env is inherited; the host itself restricts pass-
            // through to the agent child to `secret_env_names` (PRD 3.7).
            {
                use std::os::unix::ffi::OsStrExt;
                for (name, value) in &spec.secrets {
                    cmd.env(name, std::ffi::OsStr::from_bytes(value.expose()));
                }
            }
            let spawned = cmd
                .spawn()
                .map_err(|e| CoreError::Host(format!("failed to spawn {}: {e}", bin.display())))?;
            let child_pid = spawned.id();
            child = Some(spawned);

            // A bound socket is not proof that the server has started
            // accepting authenticated requests. Retry the full handshake
            // until the deadline, which lets the Host pre-bind its listener
            // before spawning the child without producing a false startup
            // failure during the small server-readiness window.
            let deadline = Instant::now() + SPAWN_READY_TIMEOUT;
            let info = loop {
                if let Some(c) = child.as_mut() {
                    if let Some(status) = c.try_wait()? {
                        let tail = read_log_tail(&self.paths.host_log_path(&id), 4096);
                        return Err(CoreError::Host(format!(
                            "host exited during startup ({status}): {tail}"
                        )));
                    }
                }
                match HostClient::connect(&socket_str, &id, &session.host_token, 0) {
                    Ok((client, info)) => {
                        drop(client);
                        break info;
                    }
                    // A responding Host that fails the authenticated protocol
                    // check cannot become valid by waiting; fail closed rather
                    // than masking an identity/version problem as startup lag.
                    Err(CoreError::Protocol(message)) => {
                        return Err(CoreError::Protocol(message));
                    }
                    // Missing listener, an accepted-yet-not-served connection,
                    // and a transient handshake timeout are all expected until
                    // the pre-bound Host completes setup.
                    Err(CoreError::Host(_)) => {}
                    Err(error) => return Err(error),
                }
                if Instant::now() >= deadline {
                    let tail = read_log_tail(&self.paths.host_log_path(&id), 4096);
                    return Err(CoreError::Host(format!(
                        "host did not complete a verified handshake within {}s: {tail}",
                        SPAWN_READY_TIMEOUT.as_secs(),
                    )));
                }
                std::thread::sleep(Duration::from_millis(50));
            };

            if info.host_pid != child_pid {
                return Err(CoreError::Protocol(format!(
                    "host pid mismatch during launch: spawned={child_pid} handshake={}",
                    info.host_pid
                )));
            }
            if info.protocol >= PROTOCOL_VERSION
                && (info.run_id != run.run_id || info.run_ordinal != run.run_ordinal)
            {
                return Err(CoreError::Protocol(format!(
                    "host run mismatch during launch: expected {}/{} got {}/{}",
                    run.run_id, run.run_ordinal, info.run_id, info.run_ordinal
                )));
            }
            if !self.db.bind_session_host_for_run(
                &id,
                &run.run_id,
                run.run_ordinal,
                child_pid as i64,
                &socket_str,
            )? {
                return Err(CoreError::Conflict(format!(
                    "session {id} launch was superseded by a newer run"
                )));
            }
            bound_host_pid = Some(child_pid as i64);
            if !self.db.update_session_lifecycle_if_host(
                &id,
                child_pid as i64,
                Some((&run.run_id, run.run_ordinal)),
                Lifecycle::Running,
            )? {
                return Err(CoreError::Conflict(format!(
                    "session {id} lifecycle changed while its host was starting"
                )));
            }
            Ok(info)
        };

        match launch_run() {
            Ok(info) => {
                let child = child.take().expect("host spawned");
                spawn_host_reaper(
                    self.paths.clone(),
                    id,
                    child,
                    run.run_id.clone(),
                    run.run_ordinal,
                );
                Ok(info)
            }
            Err(e) => {
                if let Some(c) = child.as_mut() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                // Only the current run may report its own launch failure. If
                // another restart has claimed the Session, leave its files and
                // lifecycle alone; it owns the stable socket/config paths.
                let still_current = match bound_host_pid {
                    Some(host_pid) => self
                        .db
                        .update_session_lifecycle_if_host(
                            &id,
                            host_pid,
                            Some((&run.run_id, run.run_ordinal)),
                            Lifecycle::Exited,
                        )
                        .unwrap_or(false),
                    None => self
                        .db
                        .update_session_lifecycle_if_run(
                            &id,
                            &run.run_id,
                            run.run_ordinal,
                            Lifecycle::Exited,
                        )
                        .unwrap_or(false),
                };
                if still_current {
                    let _ = std::fs::remove_file(&socket_path);
                    let _ = std::fs::remove_file(&config_path);
                }
                Err(e)
            }
        }
    }

    /// Connect to a host and prove that the answered socket still belongs to
    /// the PID/run currently recorded in SQLite. This does not mutate state;
    /// callers choose the appropriate terminal classification for failures.
    fn connect_bound_host(
        &self,
        session_id: &str,
    ) -> Result<(HostClient, AttachInfo, SessionHostBinding)> {
        self.connect_bound_host_with_resume(session_id, 0, None, true)
    }

    fn connect_bound_host_with_resume(
        &self,
        session_id: &str,
        replay_tail_bytes: u64,
        resume_from: Option<LogCursor>,
        subscribe_output: bool,
    ) -> Result<(HostClient, AttachInfo, SessionHostBinding)> {
        let session = self.db.get_session(session_id)?;
        let binding = self.db.session_host_binding(session_id)?;
        let expected_pid = binding.host_pid.ok_or_else(|| {
            CoreError::Host("no host pid recorded for the active session run".into())
        })?;
        let socket = match &session.host_socket {
            Some(s) if !s.is_empty() => s.clone(),
            _ => return Err(CoreError::Host("no host socket recorded".into())),
        };
        if session.host_token.is_empty() {
            return Err(CoreError::Host("no host token recorded".into()));
        }
        let (client, info) = HostClient::connect_with_resume(
            &socket,
            session_id,
            &session.host_token,
            replay_tail_bytes,
            resume_from,
            subscribe_output,
        )?;
        if info.host_pid as i64 != expected_pid {
            return Err(CoreError::Protocol(format!(
                "host pid mismatch: database={expected_pid} handshake={}",
                info.host_pid
            )));
        }
        if info.protocol >= PROTOCOL_VERSION {
            if let Some((run_id, run_ordinal)) = binding.run_identity() {
                if info.run_id != run_id || info.run_ordinal != run_ordinal {
                    return Err(CoreError::Protocol(format!(
                        "host run mismatch: database={run_id}/{run_ordinal} handshake={}/{}",
                        info.run_id, info.run_ordinal
                    )));
                }
            }
        }
        Ok((client, info, binding))
    }

    /// Attach to an already-running host (GUI reopen path). Verifies
    /// session id + token plus the persisted PID/run binding; an unreachable
    /// socket can mark only that exact binding interrupted. We intentionally
    /// do not unlink the stable socket path here, because a concurrently
    /// claimed replacement Host may already have rebound it.
    pub fn attach(&self, session_id: &str) -> Result<(HostClient, AttachInfo)> {
        self.attach_with_resume(session_id, 0, None, true)
    }

    /// Verified attach with an explicit run-scoped replay cursor. Host token,
    /// socket path, PID binding and run checks remain inside Core; callers get
    /// only the authenticated client and public handshake facts.
    pub fn attach_with_resume(
        &self,
        session_id: &str,
        replay_tail_bytes: u64,
        resume_from: Option<LogCursor>,
        subscribe_output: bool,
    ) -> Result<(HostClient, AttachInfo)> {
        // Retain the observation made before the socket operation. Re-reading
        // after an I/O failure could instead capture a replacement Host and
        // incorrectly mark that newer run interrupted.
        let observed_binding = self.db.session_host_binding(session_id).ok();
        match self.connect_bound_host_with_resume(
            session_id,
            replay_tail_bytes,
            resume_from,
            subscribe_output,
        ) {
            Ok((client, info, _binding)) => Ok((client, info)),
            Err(CoreError::Host(_)) => {
                if let Some(binding) = observed_binding {
                    if let Some(host_pid) = binding.host_pid {
                        // A failed connect alone is not a terminal fact. Keep
                        // the session live while its recorded Host PID still
                        // exists; a monitor/reconciliation pass can retry.
                        if !pid_alive(host_pid as i32) {
                            let _ = self.db.update_session_lifecycle_if_host(
                                session_id,
                                host_pid,
                                binding.run_identity(),
                                Lifecycle::Interrupted,
                            );
                        }
                    }
                }
                Err(CoreError::Host(
                    "host is unreachable or no longer authoritative".into(),
                ))
            }
            Err(e) => Err(e),
        }
    }

    /// Graceful stop via an authenticated socket `stop` frame.  A stale
    /// database PID is never signalled: once the Host can no longer prove its
    /// identity, the only safe lifecycle is `Interrupted`, not a claimed
    /// `Stopped` result that may leave an Agent (or hit a reused PID) behind.
    pub fn stop(&self, session_id: &str, grace_ms: u64) -> Result<()> {
        let session = self.db.get_session(session_id)?;
        if stop_is_complete(session.lifecycle) {
            return Ok(()); // idempotent
        }
        let observed_binding = self.db.session_host_binding(session_id).ok();
        match self.connect_bound_host(session_id) {
            Ok((mut client, info, binding)) => {
                // The Host owns process-group escalation and reports the
                // durable terminal fact.  Treat a failed write or an
                // unverified disappearance as a stop failure rather than
                // applying an unsafe naked-PID fallback.
                client.request_stop(grace_ms)?;
                if info.host_pid == 0 {
                    return Err(CoreError::Host(
                        "stop sent but host pid was not available for verification".into(),
                    ));
                }
                let _ = client
                    .reader
                    .get_ref()
                    .set_read_timeout(Some(Duration::from_millis(grace_ms.saturating_add(3_000))));
                let mut exit_group_cleaned = false;
                loop {
                    match client.read_frame() {
                        Ok(Some(HostFrame::Exit {
                            session_id: exit_session,
                            group_cleaned,
                            ..
                        })) if exit_session == session_id => {
                            exit_group_cleaned = group_cleaned;
                            break;
                        }
                        Ok(Some(_)) => continue,
                        Ok(None) | Err(_) => break,
                    }
                }
                if !wait_pid_gone(
                    info.host_pid as i32,
                    Duration::from_millis(grace_ms.saturating_add(3_000)),
                ) {
                    return Err(CoreError::Host(
                        "host did not stop within the verified grace period".into(),
                    ));
                }
                if !exit_group_cleaned
                    && !stopped_run_is_group_cleaned(
                        self.paths,
                        session_id,
                        info.host_pid as i64,
                        binding.run_identity(),
                    )
                {
                    return Err(CoreError::Host(
                        "host stopped but full process-group cleanup was not proven".into(),
                    ));
                }
                if !self.db.update_session_lifecycle_if_host(
                    session_id,
                    info.host_pid as i64,
                    binding.run_identity(),
                    Lifecycle::Stopped,
                )? {
                    // A concurrent observer (e.g. the GUI monitor consuming
                    // the Host's Exit frame) may have already recorded the
                    // terminal fact. An already-terminal Session means
                    // the stop goal is achieved, not a replacement conflict.
                    let current = self.db.get_session(session_id)?;
                    if stop_is_complete(current.lifecycle) {
                        return Ok(());
                    }
                    return Err(CoreError::Conflict(format!(
                        "session {session_id} was replaced while stop completed"
                    )));
                }
                Ok(())
            }
            Err(CoreError::Host(_)) => {
                // Reconcile only the exact PID binding observed before the
                // failed connection. A verified-dead Host makes the stop goal
                // complete. During orderly shutdown an older Host may unlink
                // its socket just before persisting its terminal state, so wait
                // briefly for that authoritative fact instead of surfacing a
                // transient archive failure.
                if let Some(binding) = observed_binding {
                    if binding.host_pid.is_some()
                        && self.wait_for_unreachable_stop_completion(session_id, &binding)?
                    {
                        return Ok(());
                    }
                }
                if stop_is_complete(self.db.get_session(session_id)?.lifecycle) {
                    return Ok(());
                }
                Err(CoreError::Host(
                    "host is unreachable; stop cannot be verified safely".into(),
                ))
            }
            // Protocol mismatch: the process behind the socket is NOT our
            // host. Do not kill the recorded pid (it may have been reused).
            Err(e) => Err(e),
        }
    }

    pub fn interrupt(&self, session_id: &str) -> Result<()> {
        // attach performs the verified handshake; the interrupt frame maps to
        // SIGINT on the child pgrp inside the host.
        let (mut client, _info) = self.attach(session_id)?;
        client.interrupt()
    }

    pub fn resume(&self, session_id: &str) -> Result<()> {
        let (mut client, _info) = self.attach(session_id)?;
        client.resume()
    }

    /// Reconcile the currently recorded Host after a transport failure.
    /// Returns true only when the same live PID/run binding remains current;
    /// a failed socket operation alone is never treated as proof of death.
    pub fn reconcile_session_liveness(&self, session_id: &str) -> Result<bool> {
        let session = self.db.get_session(session_id)?;
        if !matches!(session.lifecycle, Lifecycle::Creating | Lifecycle::Running) {
            return Ok(false);
        }
        let binding = self.db.session_host_binding(session_id)?;
        let Some(host_pid) = binding
            .host_pid
            .filter(|pid| *pid > 0 && *pid <= i64::from(i32::MAX))
        else {
            return Ok(false);
        };

        self.reconcile_unreachable_binding(session_id, &binding)?;

        let current = self.db.get_session(session_id)?;
        if !matches!(current.lifecycle, Lifecycle::Creating | Lifecycle::Running)
            || current.host_pid != Some(host_pid)
        {
            return Ok(false);
        }
        let current_binding = self.db.session_host_binding(session_id)?;
        Ok(current_binding.host_pid == Some(host_pid)
            && current_binding.run_id == binding.run_id
            && current_binding.run_ordinal == binding.run_ordinal)
    }

    /// Apply an offline-host classification only if the binding observed
    /// before the failed socket operation is still current. New sessions have
    /// a run claim even before a PID exists; pre-v5 rows fall back to the
    /// explicitly unbound compatibility CAS.
    fn reconcile_unreachable_binding(
        &self,
        session_id: &str,
        binding: &SessionHostBinding,
    ) -> Result<()> {
        match (binding.host_pid, binding.run_identity()) {
            (Some(host_pid), run) => {
                // A socket failure is not a terminal fact by itself: the
                // Host may still be alive while its listener is restarting or
                // temporarily saturated. Classify only a matching durable
                // exit record or a verified-dead Host PID.
                if let Some(next) =
                    terminal_lifecycle_from_host_state(self.paths, session_id, host_pid, run)
                {
                    let _ = self
                        .db
                        .update_session_lifecycle_if_host(session_id, host_pid, run, next)?;
                } else if !pid_alive(host_pid as i32) {
                    if let Some((run_id, run_ordinal)) = run {
                        let _ = self.db.mark_host_interrupted_and_record(
                            session_id,
                            host_pid,
                            run_id,
                            run_ordinal,
                            "host:interrupted:pid-dead",
                        )?;
                    } else {
                        // This is compatibility-only data with no durable run
                        // identity.  Preserve the lifecycle fact, but do not
                        // invent a run-scoped timeline event we cannot fence.
                        let _ = self.db.update_session_lifecycle_if_host(
                            session_id,
                            host_pid,
                            None,
                            Lifecycle::Interrupted,
                        )?;
                    }
                } else {
                    tracing::warn!(
                        session = %session_id,
                        host_pid,
                        "host socket unavailable while recorded process remains alive; retaining lifecycle"
                    );
                }
            }
            (None, Some((run_id, run_ordinal))) => {
                let _ = self.db.update_session_lifecycle_if_run(
                    session_id,
                    run_id,
                    run_ordinal,
                    Lifecycle::Interrupted,
                )?;
            }
            (None, None) => {
                let _ = self
                    .db
                    .update_session_lifecycle_if_unbound(session_id, Lifecycle::Interrupted)?;
            }
        }
        Ok(())
    }

    fn wait_for_unreachable_stop_completion(
        &self,
        session_id: &str,
        binding: &SessionHostBinding,
    ) -> Result<bool> {
        self.reconcile_unreachable_binding(session_id, binding)?;
        if stop_is_complete(self.db.get_session(session_id)?.lifecycle) {
            return Ok(true);
        }

        let Some(host_pid) = binding.host_pid else {
            return Ok(false);
        };
        let deadline = Instant::now() + UNREACHABLE_STOP_RECONCILE_TIMEOUT;
        loop {
            if terminal_lifecycle_from_host_state(
                self.paths,
                session_id,
                host_pid,
                binding.run_identity(),
            )
            .is_some()
                || !pid_alive(host_pid as i32)
            {
                self.reconcile_unreachable_binding(session_id, binding)?;
                return Ok(stop_is_complete(self.db.get_session(session_id)?.lifecycle));
            }
            if Instant::now() >= deadline {
                return Ok(false);
            }
            std::thread::sleep(UNREACHABLE_STOP_RECONCILE_POLL);
        }
    }

    /// Startup reconciliation (PRD 3.3): for every session marked running,
    /// verify the host (socket handshake). Dead hosts -> lifecycle=interrupted,
    /// keep logs/metadata, and never unlink a stable socket path that a newer
    /// Host may have rebound. Never auto-restart.
    pub fn reconcile_on_startup(&self) -> Result<Vec<Session>> {
        let candidates: Vec<Session> = self
            .db
            .list_sessions(None, false)?
            .into_iter()
            .filter(|s| matches!(s.lifecycle, Lifecycle::Creating | Lifecycle::Running))
            .collect();

        let mut out = Vec::with_capacity(candidates.len());
        for s in candidates {
            // A GUI may restart while a just-spawned Host is still creating
            // its socket.  Give `Creating` a bounded retry window before
            // declaring it interrupted; this never signals or deletes a live
            // process, it merely avoids a false negative during startup.
            let retry_deadline = if matches!(s.lifecycle, Lifecycle::Creating) {
                Instant::now() + Duration::from_secs(2)
            } else {
                Instant::now()
            };
            let check = loop {
                // Keep the exact pre-I/O authority observation with the
                // result. It becomes the CAS predicate if the connection
                // fails; a newer launch cannot be classified by this pass.
                let binding = self.db.session_host_binding(&s.id)?;
                let result = match self.connect_bound_host(&s.id) {
                    Ok((_, info, _)) => Ok((binding, info.log_cursor)),
                    Err(error) => Err((error, binding)),
                };
                if result.is_ok()
                    || !matches!(s.lifecycle, Lifecycle::Creating)
                    || Instant::now() >= retry_deadline
                {
                    break result;
                }
                std::thread::sleep(Duration::from_millis(100));
            };
            // Import before deciding the lifecycle so an offline Host's own
            // final status is available even when the socket has already been
            // removed.
            let (_imported, skipped) = self.import_status_events(&s.id);
            if skipped > 0 {
                tracing::warn!(session = %s.id, skipped, "reconcile: skipped unparseable status-event lines");
            }
            match check {
                Ok((_binding, log_cursor)) => {
                    // This Host handshake is the only authoritative source
                    // for GUI-closed output progress.  Persist it so a later
                    // recovery entry can validate run + generation + offset.
                    self.db.set_latest_log_cursor(&s.id, &log_cursor)?;
                }
                Err((CoreError::Host(_), binding)) => {
                    // No unlink here: session socket paths are stable across
                    // restarts, so unlinking after a failed old observation
                    // can sever a newly bound Host.
                    self.reconcile_unreachable_binding(&s.id, &binding)?;
                }
                Err((CoreError::Protocol(m), binding)) => {
                    // Something answers but fails the identity check — not our
                    // host. Mark interrupted but do NOT remove the socket file
                    // (it may belong to a live, unrelated process).
                    tracing::warn!(session = %s.id, error = %m, "reconcile: handshake identity mismatch");
                    self.reconcile_unreachable_binding(&s.id, &binding)?;
                }
                Err((e, _)) => return Err(e),
            }
            out.push(self.db.get_session(&s.id)?);
        }
        // Status-event import runs for EVERY non-archived session, including
        // stopped/exited ones: events emitted while the GUI was away are
        // exactly what the recovery timeline needs (PRD 3.6).
        for s in self.db.list_sessions(None, false)? {
            if matches!(s.lifecycle, Lifecycle::Creating | Lifecycle::Running) {
                continue; // already imported above
            }
            let (_imported, skipped) = self.import_status_events(&s.id);
            if skipped > 0 {
                tracing::warn!(session = %s.id, skipped, "reconcile: skipped unparseable status-event lines");
            }
        }
        Ok(out)
    }

    /// Import `<session_dir>/status-events.jsonl` (StatusEvent JSON lines
    /// appended by the host) into the db. Idempotent by (session_id, sequence)
    /// via INSERT OR IGNORE; unparseable/foreign lines are skipped and counted.
    /// Returns (imported, skipped).
    fn import_status_events(&self, session_id: &str) -> (u64, u64) {
        let path = self
            .paths
            .session_dir(session_id)
            .join("status-events.jsonl");
        let Ok(f) = std::fs::File::open(&path) else {
            return (0, 0);
        };
        let mut imported = 0u64;
        let mut skipped = 0u64;
        for line in BufReader::new(f).lines() {
            let Ok(line) = line else {
                skipped += 1;
                continue;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<StatusEvent>(trimmed) {
                Ok(ev) if ev.session_id == session_id => match self.db.record_status_event(&ev) {
                    Ok(()) => imported += 1,
                    Err(_) => skipped += 1,
                },
                _ => skipped += 1,
            }
        }
        (imported, skipped)
    }

    /// True when a host answers the handshake for this session.
    pub fn is_alive(&self, session_id: &str) -> bool {
        self.connect_bound_host(session_id).is_ok()
    }
}

/// Write a file with 0600 permissions (helper configs such as per-session
/// claude settings). Never used for secret values — only non-secret config.
pub fn write_private_file(path: &str, contents: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if let Some(parent) = std::path::Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())?;
    Ok(())
}

/// Detached reaper for one launched host: waits for exit (reaping the pid so
/// it never zombifies), then reconciles the session lifecycle from the host's
/// own exit record. A clean host exit writes `host-state.json` with an
/// explicit reason, which maps user stop to `Stopped` and every other clean
/// terminal reason to `Exited`; anything else (crash, SIGKILL) is
/// `Interrupted` when the session was believed running (PRD 3.3 失败路径 B).
fn spawn_host_reaper(
    paths: AppPaths,
    session_id: String,
    mut child: Child,
    run_id: String,
    run_ordinal: i64,
) {
    let host_pid = child.id() as i64;
    std::thread::spawn(move || {
        let _ = child.wait(); // reaps the pid — no zombies, ever
        let terminal_lifecycle = terminal_lifecycle_from_host_state(
            &paths,
            &session_id,
            host_pid,
            Some((&run_id, run_ordinal)),
        );
        let Ok(db) = Db::open(&paths) else {
            return;
        };
        if let Some(next) = terminal_lifecycle {
            // The reaper has no authority over a replacement Host/run. A
            // false CAS is expected when restart won the race and needs no
            // retry.
            let _ = db.update_session_lifecycle_if_host(
                &session_id,
                host_pid,
                Some((&run_id, run_ordinal)),
                next,
            );
        } else {
            // `wait` observed this exact Host child exit, but no trustworthy
            // host-state record establishes a graceful terminal reason.
            let _ = db.mark_host_interrupted_and_record(
                &session_id,
                host_pid,
                &run_id,
                run_ordinal,
                "host:interrupted:reaper-observed-exit-without-record",
            );
        }
    });
}

/// A verified connection to a host. All frames carry the session id.
pub struct HostClient {
    pub reader: BufReader<UnixStream>,
    pub writer: UnixStream,
    pub session_id: String,
    pub protocol: u32,
    features: Vec<String>,
    token: String,
}

impl std::fmt::Debug for HostClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HostClient")
            .field("session_id", &self.session_id)
            .field("protocol", &self.protocol)
            .field("features", &self.features)
            .field("token", &"[redacted]")
            .finish_non_exhaustive()
    }
}

struct ProtocolConnectOptions {
    resume_from: Option<LogCursor>,
    replay_target: Option<LogCursor>,
    subscribe_output: bool,
    requested_protocol: u32,
}

impl HostClient {
    /// Connect + handshake; returns client + hello_ok info.
    pub fn connect(
        socket_path: &str,
        session_id: &str,
        token: &str,
        replay_tail_bytes: u64,
    ) -> Result<(Self, AttachInfo)> {
        Self::connect_with_resume(
            socket_path,
            session_id,
            token,
            replay_tail_bytes,
            None,
            true,
        )
    }

    /// Connect using a v2 output cursor. `subscribe_output=false` creates a
    /// lightweight status-only connection for a Session monitor. During the
    /// rolling-upgrade window, a protocol rejection gets exactly one v1 retry;
    /// ordinary socket errors never trigger a fallback or stale-socket action.
    pub fn connect_with_resume(
        socket_path: &str,
        session_id: &str,
        token: &str,
        replay_tail_bytes: u64,
        resume_from: Option<LogCursor>,
        subscribe_output: bool,
    ) -> Result<(Self, AttachInfo)> {
        Self::connect_with_recovery_target(
            socket_path,
            session_id,
            token,
            replay_tail_bytes,
            resume_from,
            None,
            subscribe_output,
        )
    }

    /// Connect with a bounded recovery-context target. This remains separate
    /// from normal resume so a regular reconnect never skips a contiguous
    /// stream merely because an old timeline entry exists.
    pub fn connect_with_recovery_target(
        socket_path: &str,
        session_id: &str,
        token: &str,
        replay_tail_bytes: u64,
        resume_from: Option<LogCursor>,
        replay_target: Option<LogCursor>,
        subscribe_output: bool,
    ) -> Result<(Self, AttachInfo)> {
        match Self::connect_protocol(
            socket_path,
            session_id,
            token,
            replay_tail_bytes,
            ProtocolConnectOptions {
                resume_from: resume_from.clone(),
                replay_target: replay_target.clone(),
                subscribe_output,
                requested_protocol: PROTOCOL_VERSION,
            },
        ) {
            Ok(connected) => Ok(connected),
            // An old v1 Host rejects v2 before it receives any application
            // command. Retry only this authenticated handshake once.
            Err(CoreError::Protocol(_)) => Self::connect_protocol(
                socket_path,
                session_id,
                token,
                replay_tail_bytes,
                ProtocolConnectOptions {
                    resume_from: None,
                    replay_target: None,
                    subscribe_output,
                    requested_protocol: LEGACY_PROTOCOL_VERSION,
                },
            ),
            Err(error) => Err(error),
        }
    }

    fn connect_protocol(
        socket_path: &str,
        session_id: &str,
        token: &str,
        replay_tail_bytes: u64,
        options: ProtocolConnectOptions,
    ) -> Result<(Self, AttachInfo)> {
        let ProtocolConnectOptions {
            resume_from,
            replay_target,
            subscribe_output,
            requested_protocol,
        } = options;
        let stream = UnixStream::connect(socket_path).map_err(|e| {
            use std::io::ErrorKind::*;
            match e.kind() {
                NotFound | ConnectionRefused => CoreError::Host("host not reachable".into()),
                _ => CoreError::Host(format!("host not reachable: {e}")),
            }
        })?;
        stream
            .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .map_err(io_host("set handshake timeout"))?;

        let mut writer = stream;
        write_frame(
            &mut writer,
            &ClientFrame::Hello {
                protocol: requested_protocol,
                session_id: session_id.to_string(),
                token: token.to_string(),
                replay_tail_bytes,
                resume_from,
                replay_target,
                subscribe_output,
            },
        )
        .map_err(io_host("send hello"))?;

        let mut reader = BufReader::new(writer.try_clone().map_err(io_host("clone socket"))?);
        let first: Option<HostFrame> = crate::protocol::read_frame(&mut reader).map_err(|e| {
            use std::io::ErrorKind::*;
            match e.kind() {
                WouldBlock | TimedOut => CoreError::Host("handshake timed out".into()),
                _ => CoreError::Host(format!("handshake failed: {e}")),
            }
        })?;
        let frame = first
            .ok_or_else(|| CoreError::Host("host closed connection during handshake".into()))?;
        let frame = normalize_host_frame(requested_protocol, frame);

        let info = match frame {
            HostFrame::HelloOk {
                protocol,
                session_id: sid,
                host_pid,
                child_alive,
                log_bytes,
                agent_session_id,
                run_id,
                run_ordinal,
                current_status,
                log_cursor,
                features,
                terminal_geometry,
            } => {
                if protocol != requested_protocol {
                    return Err(CoreError::Protocol(format!(
                        "protocol version mismatch: host={protocol} requested={requested_protocol}"
                    )));
                }
                if sid != session_id {
                    return Err(CoreError::Protocol(
                        "session id mismatch in hello_ok".into(),
                    ));
                }
                AttachInfo {
                    session_id: sid,
                    protocol,
                    host_pid,
                    child_alive,
                    log_bytes,
                    agent_session_id,
                    run_id,
                    run_ordinal,
                    current_status,
                    log_cursor,
                    features,
                    terminal_geometry,
                }
            }
            HostFrame::Error {
                message,
                code,
                params,
                technical_detail,
                ..
            } => {
                return Err(match code {
                    Some(code) => CoreError::RuntimeMessage {
                        code,
                        params: params.unwrap_or_else(|| serde_json::json!({})),
                        technical_detail: technical_detail.unwrap_or_else(|| message.clone()),
                        message,
                    },
                    None => CoreError::Protocol(message),
                })
            }
            other => {
                return Err(CoreError::Protocol(format!(
                    "unexpected first frame from host: {other:?}"
                )))
            }
        };

        // Handshake done: back to blocking mode for the live stream. Both
        // handles share the underlying socket, so this clears the timeout for
        // the reader too. On macOS, setsockopt on an already-disconnected
        // socket fails with EINVAL — treat that as a dead host.
        writer
            .set_read_timeout(None)
            .map_err(|e| CoreError::Host(format!("socket unusable right after handshake: {e}")))?;

        let client = HostClient {
            reader,
            writer,
            session_id: session_id.to_string(),
            protocol: requested_protocol,
            features: info.features.clone(),
            token: token.to_string(),
        };
        Ok((client, info))
    }

    fn write(&mut self, frame: &ClientFrame) -> Result<()> {
        write_frame(&mut self.writer, frame).map_err(io_host("socket write failed"))
    }

    pub fn send_input(&mut self, data: &[u8]) -> Result<()> {
        self.write(&ClientFrame::Input {
            session_id: self.session_id.clone(),
            data: data.to_vec(),
        })
    }

    pub fn supports_input_batches(&self) -> bool {
        self.features
            .iter()
            .any(|feature| feature == HOST_FEATURE_INPUT_BATCH_V1)
    }

    /// Submit one atomic terminal input unit. Callers must retain `batch_id`
    /// until they observe a terminal acknowledgement; an EOF before then is an
    /// unknown write and must never trigger automatic replay.
    pub fn send_input_batch(&mut self, batch_id: &str, data: &[u8]) -> Result<()> {
        if !self.supports_input_batches() {
            return Err(CoreError::Protocol(
                "host does not support atomic input batches".into(),
            ));
        }
        self.write(&ClientFrame::InputBatch {
            session_id: self.session_id.clone(),
            batch_id: batch_id.to_string(),
            data: data.to_vec(),
        })
    }
    pub fn send_structured_prompt(&mut self, text: &str) -> Result<()> {
        self.write(&ClientFrame::StructuredPrompt {
            session_id: self.session_id.clone(),
            text: text.to_string(),
        })
    }

    pub fn abort_structured_turn(&mut self) -> Result<()> {
        self.write(&ClientFrame::AbortStructuredTurn {
            session_id: self.session_id.clone(),
        })
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.write(&ClientFrame::Resize {
            session_id: self.session_id.clone(),
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
            expected_revision: None,
            source_kind: None,
            source_device_id: None,
            attachment_id: None,
            orientation: None,
        })
    }

    pub fn supports_terminal_geometry(&self) -> bool {
        self.features
            .iter()
            .any(|feature| feature == HOST_FEATURE_TERMINAL_GEOMETRY_V1)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn resize_with_geometry(
        &mut self,
        cols: u16,
        rows: u16,
        expected_revision: u64,
        source_kind: &str,
        source_device_id: Option<&str>,
        attachment_id: &str,
        orientation: Option<&str>,
    ) -> Result<()> {
        if !self.supports_terminal_geometry() {
            return Err(CoreError::Protocol(
                "host does not support revisioned terminal geometry".into(),
            ));
        }
        self.write(&ClientFrame::Resize {
            session_id: self.session_id.clone(),
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
            expected_revision: Some(expected_revision),
            source_kind: Some(source_kind.to_string()),
            source_device_id: source_device_id.map(str::to_owned),
            attachment_id: Some(attachment_id.to_string()),
            orientation: orientation.map(str::to_owned),
        })
    }
    pub fn interrupt(&mut self) -> Result<()> {
        self.write(&ClientFrame::Interrupt {
            session_id: self.session_id.clone(),
        })
    }
    pub fn resume(&mut self) -> Result<()> {
        self.write(&ClientFrame::Continue {
            session_id: self.session_id.clone(),
        })
    }
    /// Ask the host to stop the session. Does not wait for the Exit frame —
    /// the caller reads frames or polls the host process itself.
    pub fn request_stop(&mut self, grace_ms: u64) -> Result<()> {
        self.write(&ClientFrame::Stop {
            session_id: self.session_id.clone(),
            grace_ms,
        })
    }
    pub fn ping(&mut self) -> Result<()> {
        self.write(&ClientFrame::Ping {
            session_id: self.session_id.clone(),
        })
    }
    pub fn detach(&mut self) -> Result<()> {
        self.write(&ClientFrame::Detach {
            session_id: self.session_id.clone(),
        })
    }
    /// Ask a legacy Host for its current status after a v1 handshake. v2
    /// carries this snapshot in `HelloOk`, so callers use this only during the
    /// rolling compatibility window.
    pub fn request_status(&mut self) -> Result<()> {
        self.write(&ClientFrame::StatusRequest {
            session_id: self.session_id.clone(),
        })
    }
    /// Blocking read of one frame (None on EOF).
    pub fn read_frame(&mut self) -> Result<Option<HostFrame>> {
        crate::protocol::read_frame(&mut self.reader)
            .map(|frame| frame.map(|frame| normalize_host_frame(self.protocol, frame)))
            .map_err(|e| CoreError::Host(format!("socket read failed: {e}")))
    }

    /// Open a fresh verified connection to the same host (same session id +
    /// token), e.g. after this connection was lost. `replay_tail_bytes` asks
    /// the host to replay that many bytes of recent log output.
    pub fn reconnect(
        &self,
        socket_path: &str,
        replay_tail_bytes: u64,
    ) -> Result<(Self, AttachInfo)> {
        Self::connect(
            socket_path,
            &self.session_id,
            &self.token,
            replay_tail_bytes,
        )
    }
}

// ---------------------------------------------------------------------------
// Tests: in-process mock host (no real agentport-host binary needed).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids;
    use chrono::Utc;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::JoinHandle;

    #[derive(Clone, Copy)]
    enum MockMode {
        /// Full protocol: verify Hello, echo Input, Pong, Exit on Stop.
        Normal,
        /// A real v1 wire shape: reject v2, then omit every run-aware field.
        LegacyStream,
        /// Accept connections but never speak (handshake timeout test).
        Silent,
    }

    struct MockHost {
        socket: PathBuf,
        shutdown: Arc<AtomicBool>,
        handle: Option<JoinHandle<()>>,
    }

    impl MockHost {
        fn start(socket: &Path, session_id: &str, token: &str, mode: MockMode) -> Self {
            let _ = std::fs::remove_file(socket);
            if let Some(parent) = socket.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            let listener = UnixListener::bind(socket).expect("bind mock socket");
            listener.set_nonblocking(true).unwrap();
            let shutdown = Arc::new(AtomicBool::new(false));
            let sd = shutdown.clone();
            let sid = session_id.to_string();
            let tok = token.to_string();
            let handle = std::thread::spawn(move || {
                while !sd.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            // macOS: accepted sockets inherit O_NONBLOCK from
                            // a nonblocking listener — force blocking mode.
                            let _ = stream.set_nonblocking(false);
                            let sd2 = sd.clone();
                            let sid2 = sid.clone();
                            let tok2 = tok.clone();
                            std::thread::spawn(move || serve(stream, sid2, tok2, mode, sd2));
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => break,
                    }
                }
            });
            MockHost {
                socket: socket.to_path_buf(),
                shutdown,
                handle: Some(handle),
            }
        }
    }

    impl Drop for MockHost {
        fn drop(&mut self) {
            self.shutdown.store(true, Ordering::Relaxed);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
            let _ = std::fs::remove_file(&self.socket);
        }
    }

    fn serve(
        stream: UnixStream,
        sid: String,
        token: String,
        mode: MockMode,
        shutdown: Arc<AtomicBool>,
    ) {
        if matches!(mode, MockMode::Silent) {
            // Hold the connection open, say nothing, until torn down.
            let _stream = stream;
            while !shutdown.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
            return;
        }
        let mut writer = match stream.try_clone() {
            Ok(w) => w,
            Err(_) => return,
        };
        let mut reader = BufReader::new(stream);
        let hello: Option<ClientFrame> = match crate::protocol::read_frame(&mut reader) {
            Ok(f) => f,
            Err(_) => return,
        };
        let requested_protocol = match &hello {
            Some(ClientFrame::Hello {
                protocol,
                session_id,
                token: presented_token,
                ..
            }) if *session_id == sid && *presented_token == token => *protocol,
            _ => {
                let _ = write_frame(
                    &mut writer,
                    &HostFrame::Error {
                        session_id: None,
                        message: "bad session id or token".into(),
                        code: None,
                        params: None,
                        technical_detail: None,
                    },
                );
                return;
            }
        };
        if matches!(mode, MockMode::LegacyStream) {
            if requested_protocol != LEGACY_PROTOCOL_VERSION {
                let _ = write_frame(
                    &mut writer,
                    &HostFrame::Error {
                        session_id: Some(sid),
                        message: "unsupported protocol".into(),
                        code: None,
                        params: None,
                        technical_detail: None,
                    },
                );
                return;
            }
            if write_frame(
                &mut writer,
                &serde_json::json!({
                    "type": "hello_ok",
                    "protocol": LEGACY_PROTOCOL_VERSION,
                    "session_id": sid,
                    "host_pid": std::process::id(),
                    "child_alive": true,
                    "log_bytes": 8,
                }),
            )
            .and_then(|_| {
                write_frame(
                    &mut writer,
                    &serde_json::json!({
                        "type": "output",
                        "session_id": sid,
                        "data": "YWJjZA==",
                        "offset": 0,
                    }),
                )
            })
            .and_then(|_| {
                write_frame(
                    &mut writer,
                    &serde_json::json!({
                        "type": "output",
                        "session_id": sid,
                        "data": "ZWZnaA==",
                        "offset": 4,
                    }),
                )
            })
            .and_then(|_| {
                write_frame(
                    &mut writer,
                    &serde_json::json!({
                        "type": "replay_done",
                        "session_id": sid,
                        "offset": 8,
                    }),
                )
            })
            .is_err()
            {
                return;
            }
            loop {
                let frame: Option<ClientFrame> = match crate::protocol::read_frame(&mut reader) {
                    Ok(frame) => frame,
                    Err(_) => return,
                };
                match frame {
                    Some(ClientFrame::Ping { ref session_id })
                        if write_frame(
                            &mut writer,
                            &serde_json::json!({
                                "type": "output",
                                "session_id": session_id,
                                "data": "aWprbA==",
                                "offset": 8,
                            }),
                        )
                        .and_then(|_| {
                            write_frame(
                                &mut writer,
                                &serde_json::json!({
                                    "type": "heartbeat",
                                    "session_id": session_id,
                                    "at": Utc::now(),
                                    "log_bytes": 12,
                                }),
                            )
                        })
                        .is_err() =>
                    {
                        return
                    }
                    Some(ClientFrame::Ping { .. }) => {}
                    Some(ClientFrame::Detach { .. }) | None => return,
                    _ => {}
                }
            }
        }
        if write_frame(
            &mut writer,
            &HostFrame::HelloOk {
                protocol: PROTOCOL_VERSION,
                session_id: sid.clone(),
                host_pid: std::process::id(),
                child_alive: true,
                log_bytes: 4096,
                agent_session_id: Some("agent-test-123".into()),
                run_id: LEGACY_RUN_ID.into(),
                run_ordinal: LEGACY_RUN_ORDINAL,
                current_status: None,
                log_cursor: LogCursor::default(),
                features: vec![HOST_FEATURE_INPUT_BATCH_V1.into()],
                terminal_geometry: None,
            },
        )
        .is_err()
        {
            return;
        }
        loop {
            let frame: Option<ClientFrame> = match crate::protocol::read_frame(&mut reader) {
                Ok(f) => f,
                Err(_) => return,
            };
            let Some(frame) = frame else { return };
            match frame {
                ClientFrame::Input {
                    ref session_id,
                    ref data,
                } if write_frame(
                    &mut writer,
                    &HostFrame::Output {
                        session_id: session_id.clone(),
                        data: data.clone(),
                        offset: 0,
                        cursor: LogCursor::default(),
                    },
                )
                .is_err() =>
                {
                    return
                }
                ClientFrame::Input { .. } => {}
                ClientFrame::Ping { ref session_id }
                    if write_frame(
                        &mut writer,
                        &HostFrame::Pong {
                            session_id: session_id.clone(),
                            at: Utc::now(),
                        },
                    )
                    .is_err() =>
                {
                    return
                }
                ClientFrame::Ping { .. } => {}
                ClientFrame::Stop { session_id, .. } => {
                    let _ = write_frame(
                        &mut writer,
                        &HostFrame::Exit {
                            session_id,
                            run_id: LEGACY_RUN_ID.into(),
                            run_ordinal: LEGACY_RUN_ORDINAL,
                            code: Some(0),
                            signal: None,
                            group_cleaned: true,
                            reason: "natural".into(),
                        },
                    );
                    shutdown.store(true, Ordering::Relaxed);
                    return;
                }
                _ => {}
            }
        }
    }

    // -- fixtures -------------------------------------------------------------

    fn fixture() -> (tempfile::TempDir, AppPaths, Db) {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().to_path_buf());
        paths.ensure_layout().unwrap();
        let db = Db::open_memory().unwrap();
        (dir, paths, db)
    }

    fn add_project(db: &Db, id: &str) {
        db.add_project(&Project {
            id: id.into(),
            name: "demo".into(),
            root_path: format!("/tmp/{id}"),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
    }

    fn session(id: &str, project: &str, lifecycle: Lifecycle) -> Session {
        Session {
            id: id.into(),
            project_id: project.into(),
            worktree_id: None,
            preset_id: "pre_shell_safe".into(),
            title: format!("test {id}"),
            cwd: "/tmp".into(),
            host_pid: None,
            host_socket: None,
            host_token: ids::new_host_token(),
            lifecycle,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            log_path: format!("/tmp/{id}.log"),
            adapter_type: AgentType::Shell,
            transport: AgentTransport::Pty,
            command: vec!["/bin/sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            archived_at: None,
        }
    }

    /// Leave a dead-but-present socket file behind (bind, then drop listener).
    fn leave_stale_socket(path: &Path) {
        let _ = std::fs::remove_file(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let l = UnixListener::bind(path).unwrap();
        drop(l);
        assert!(path.exists());
    }

    // -- 1. handshake success + AttachInfo ------------------------------------

    #[test]
    fn connect_handshake_success_and_echo() {
        let (_dir, paths, _db) = fixture();
        let sid = ids::new_id("ses");
        let token = ids::new_host_token();
        let sock = paths.socket_path(&sid);
        let _mock = MockHost::start(&sock, &sid, &token, MockMode::Normal);

        let (mut client, info) =
            HostClient::connect(&sock.to_string_lossy(), &sid, &token, 0).unwrap();
        assert_eq!(info.session_id, sid);
        assert_eq!(info.host_pid, std::process::id());
        assert!(info.child_alive);
        assert_eq!(info.log_bytes, 4096);
        assert_eq!(info.agent_session_id.as_deref(), Some("agent-test-123"));

        client.send_input(b"echo me").unwrap();
        match client.read_frame().unwrap() {
            Some(HostFrame::Output {
                data, session_id, ..
            }) => {
                assert_eq!(data, b"echo me");
                assert_eq!(session_id, sid);
            }
            other => panic!("expected Output, got {other:?}"),
        }
        client.ping().unwrap();
        assert!(matches!(
            client.read_frame().unwrap(),
            Some(HostFrame::Pong { .. })
        ));
        client.resize(100, 40).unwrap(); // no reply expected, must not error
        client.interrupt().unwrap();
    }

    #[test]
    fn legacy_stream_keeps_consecutive_output_and_reconnect_contiguous() {
        fn apply_output(rendered: &mut Vec<u8>, next_offset: &mut usize, frame: HostFrame) {
            let HostFrame::Output { data, cursor, .. } = frame else {
                panic!("expected output frame");
            };
            assert_eq!(cursor.run_id, LEGACY_RUN_ID);
            assert_eq!(cursor.run_ordinal, LEGACY_RUN_ORDINAL);
            assert_eq!(cursor.generation, 0);
            let start = usize::try_from(cursor.offset).unwrap();
            let end = start + data.len();
            if end <= *next_offset {
                return;
            }
            let skip = next_offset.saturating_sub(start);
            rendered.extend_from_slice(&data[skip..]);
            *next_offset = end;
        }

        let (_dir, paths, _db) = fixture();
        let sid = ids::new_id("ses");
        let token = ids::new_host_token();
        let sock = paths.socket_path(&sid);
        let _mock = MockHost::start(&sock, &sid, &token, MockMode::LegacyStream);

        let (client, info) = HostClient::connect(&sock.to_string_lossy(), &sid, &token, 8).unwrap();
        assert_eq!(info.protocol, LEGACY_PROTOCOL_VERSION);
        assert_eq!(info.log_cursor.offset, 8);

        let mut client = client;
        let mut rendered = Vec::new();
        let mut next_offset = 0;
        apply_output(
            &mut rendered,
            &mut next_offset,
            client.read_frame().unwrap().unwrap(),
        );
        apply_output(
            &mut rendered,
            &mut next_offset,
            client.read_frame().unwrap().unwrap(),
        );
        assert_eq!(rendered, b"abcdefgh");
        assert_eq!(next_offset, 8);
        assert!(matches!(
            client.read_frame().unwrap(),
            Some(HostFrame::ReplayDone { cursor, .. }) if cursor.offset == 8
        ));

        let (mut reconnected, reconnect_info) = client
            .reconnect(&sock.to_string_lossy(), 8)
            .expect("v2 rejection must fall back to v1 again on reconnect");
        drop(client);
        assert_eq!(reconnect_info.protocol, LEGACY_PROTOCOL_VERSION);
        assert_eq!(reconnect_info.log_cursor.offset, 8);

        // Replayed blocks are complete duplicates of the renderer's cursor.
        apply_output(
            &mut rendered,
            &mut next_offset,
            reconnected.read_frame().unwrap().unwrap(),
        );
        apply_output(
            &mut rendered,
            &mut next_offset,
            reconnected.read_frame().unwrap().unwrap(),
        );
        assert_eq!(rendered, b"abcdefgh");
        assert!(matches!(
            reconnected.read_frame().unwrap(),
            Some(HostFrame::ReplayDone { cursor, .. }) if cursor.offset == 8
        ));

        // The first live block after replay starts exactly at the replay cursor.
        reconnected.ping().unwrap();
        apply_output(
            &mut rendered,
            &mut next_offset,
            reconnected.read_frame().unwrap().unwrap(),
        );
        assert_eq!(rendered, b"abcdefghijkl");
        assert_eq!(next_offset, 12);
        assert!(matches!(
            reconnected.read_frame().unwrap(),
            Some(HostFrame::Heartbeat { log_cursor, .. }) if log_cursor.offset == 12
        ));
    }

    // -- 2. bad token / bad session id -> Protocol ----------------------------

    #[test]
    fn connect_bad_identity_is_protocol_error() {
        let (_dir, paths, _db) = fixture();
        let sid = ids::new_id("ses");
        let token = ids::new_host_token();
        let sock = paths.socket_path(&sid);
        let _mock = MockHost::start(&sock, &sid, &token, MockMode::Normal);

        let e = HostClient::connect(&sock.to_string_lossy(), &sid, "wrong-token-0000000000", 0)
            .unwrap_err();
        assert!(matches!(e, CoreError::Protocol(_)), "got {e:?}");

        let e = HostClient::connect(&sock.to_string_lossy(), "ses_somebody_else", &token, 0)
            .unwrap_err();
        assert!(matches!(e, CoreError::Protocol(_)), "got {e:?}");
    }

    // -- 3. attach to stale socket only transitions its own binding -----------

    #[test]
    fn attach_stale_socket_marks_interrupted_without_unlinking_stable_path() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_t3");
        let sid = ids::new_id("ses");
        let sock = paths.socket_path(&sid);
        let mut s = session(&sid, "prj_t3", Lifecycle::Running);
        s.host_socket = Some(sock.to_string_lossy().into_owned());
        db.insert_session(&s).unwrap();
        db.update_session_host(&sid, Some(999_999), Some(&sock.to_string_lossy()))
            .unwrap();
        leave_stale_socket(&sock);

        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        let e = mgr.attach(&sid).unwrap_err();
        assert!(matches!(e, CoreError::Host(_)), "got {e:?}");
        assert!(
            sock.exists(),
            "stable path is retained for a possible replacement host"
        );
        assert_eq!(
            db.get_session(&sid).unwrap().lifecycle,
            Lifecycle::Interrupted
        );
    }

    // -- 4. stop is idempotent --------------------------------------------------

    #[test]
    fn stop_idempotent_for_terminal_sessions() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_t4");
        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        for lc in [
            Lifecycle::Interrupted,
            Lifecycle::Stopped,
            Lifecycle::Exited,
        ] {
            let sid = ids::new_id("ses");
            db.insert_session(&session(&sid, "prj_t4", lc)).unwrap();
            mgr.stop(&sid, 500).unwrap();
            assert_eq!(db.get_session(&sid).unwrap().lifecycle, lc);
        }
    }

    #[test]
    fn stop_succeeds_for_archived_session_with_verified_dead_host() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_archived_dead");
        let sid = ids::new_id("ses");
        let socket = paths.socket_path(&sid);
        let mut archived = session(&sid, "prj_archived_dead", Lifecycle::Running);
        archived.host_socket = Some(socket.to_string_lossy().into_owned());
        db.insert_session(&archived).unwrap();
        db.update_session_host(&sid, Some(999_999), Some(&socket.to_string_lossy()))
            .unwrap();
        db.archive_session(&sid).unwrap();
        leave_stale_socket(&socket);

        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        mgr.stop(&sid, 500).unwrap();

        assert_eq!(
            db.get_session(&sid).unwrap().lifecycle,
            Lifecycle::Interrupted
        );
    }

    #[test]
    fn stop_keeps_running_session_when_socket_fails_but_host_pid_is_alive() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_live_unreachable");
        let sid = ids::new_id("ses");
        let socket = paths.socket_path(&sid);
        let mut running = session(&sid, "prj_live_unreachable", Lifecycle::Running);
        running.host_socket = Some(socket.to_string_lossy().into_owned());
        db.insert_session(&running).unwrap();
        db.update_session_host(
            &sid,
            Some(std::process::id() as i64),
            Some(&socket.to_string_lossy()),
        )
        .unwrap();

        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        let error = mgr.stop(&sid, 500).unwrap_err();

        assert!(matches!(error, CoreError::Host(_)), "got {error:?}");
        assert_eq!(db.get_session(&sid).unwrap().lifecycle, Lifecycle::Running);
    }

    #[test]
    fn liveness_reconciliation_retains_an_unreachable_live_host_pid() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_liveness_live");
        let sid = ids::new_id("ses");
        let socket = paths.socket_path(&sid);
        let mut running = session(&sid, "prj_liveness_live", Lifecycle::Running);
        running.host_socket = Some(socket.to_string_lossy().into_owned());
        db.insert_session(&running).unwrap();
        db.update_session_host(
            &sid,
            Some(std::process::id() as i64),
            Some(&socket.to_string_lossy()),
        )
        .unwrap();

        let manager = HostManager {
            paths: &paths,
            db: &db,
        };

        assert!(manager.reconcile_session_liveness(&sid).unwrap());
        assert_eq!(db.get_session(&sid).unwrap().lifecycle, Lifecycle::Running);
    }

    #[test]
    fn liveness_reconciliation_marks_a_dead_host_interrupted() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_liveness_dead");
        let sid = ids::new_id("ses");
        let socket = paths.socket_path(&sid);
        let mut running = session(&sid, "prj_liveness_dead", Lifecycle::Running);
        running.host_socket = Some(socket.to_string_lossy().into_owned());
        db.insert_session(&running).unwrap();
        db.update_session_host(&sid, Some(999_999), Some(&socket.to_string_lossy()))
            .unwrap();

        let manager = HostManager {
            paths: &paths,
            db: &db,
        };

        assert!(!manager.reconcile_session_liveness(&sid).unwrap());
        assert_eq!(
            db.get_session(&sid).unwrap().lifecycle,
            Lifecycle::Interrupted
        );
    }

    #[test]
    fn stop_waits_for_terminal_state_during_host_shutdown_race() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_shutdown_race");
        let sid = ids::new_id("ses");
        let socket = paths.socket_path(&sid);
        let mut running = session(&sid, "prj_shutdown_race", Lifecycle::Running);
        running.host_socket = Some(socket.to_string_lossy().into_owned());
        db.insert_session(&running).unwrap();
        let run = db.create_session_run(&sid, &ids::new_uuid()).unwrap();
        let log_path = paths.run_log_path(&sid, &run.run_id);
        db.claim_session_run(
            &sid,
            &run.run_id,
            run.run_ordinal,
            &log_path.to_string_lossy(),
        )
        .unwrap();
        let host_pid = std::process::id() as i64;
        db.bind_session_host_for_run(
            &sid,
            &run.run_id,
            run.run_ordinal,
            host_pid,
            &socket.to_string_lossy(),
        )
        .unwrap();
        db.update_session_lifecycle_if_host(
            &sid,
            host_pid,
            Some((&run.run_id, run.run_ordinal)),
            Lifecycle::Running,
        )
        .unwrap();

        let state_path = paths.session_dir(&sid).join("host-state.json");
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        let writer_sid = sid.clone();
        let writer_run_id = run.run_id.clone();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            std::fs::write(
                state_path,
                serde_json::to_vec(&serde_json::json!({
                    "session_id": writer_sid,
                    "host_pid": host_pid,
                    "run_id": writer_run_id,
                    "run_ordinal": run.run_ordinal,
                    "exited_at": Utc::now().to_rfc3339(),
                    "exit_reason": "natural"
                }))
                .unwrap(),
            )
            .unwrap();
        });

        let manager = HostManager {
            paths: &paths,
            db: &db,
        };
        let result = manager.stop(&sid, 500);
        writer.join().unwrap();

        result.unwrap();
        assert_eq!(db.get_session(&sid).unwrap().lifecycle, Lifecycle::Exited);
    }

    #[test]
    fn stop_does_not_complete_an_unbound_run_that_may_still_be_launching() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_launching_unbound");
        let sid = ids::new_id("ses");
        db.insert_session(&session(&sid, "prj_launching_unbound", Lifecycle::Creating))
            .unwrap();
        let run = db.create_session_run(&sid, &ids::new_uuid()).unwrap();
        let log_path = paths.run_log_path(&sid, &run.run_id);
        db.claim_session_run(
            &sid,
            &run.run_id,
            run.run_ordinal,
            &log_path.to_string_lossy(),
        )
        .unwrap();

        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        let error = mgr.stop(&sid, 500).unwrap_err();

        assert!(matches!(error, CoreError::Host(_)), "got {error:?}");
        assert_eq!(db.get_session(&sid).unwrap().lifecycle, Lifecycle::Creating);
    }

    // -- 5. reconcile_on_startup ------------------------------------------------

    #[test]
    fn reconcile_marks_dead_interrupted_and_imports_events_idempotently() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_t5");
        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };

        // live session behind a mock host
        let live = ids::new_id("ses");
        let mut s_live = session(&live, "prj_t5", Lifecycle::Running);
        let live_sock = paths.socket_path(&live);
        s_live.host_socket = Some(live_sock.to_string_lossy().into_owned());
        db.insert_session(&s_live).unwrap();
        db.update_session_host(
            &live,
            Some(std::process::id() as i64),
            Some(&live_sock.to_string_lossy()),
        )
        .unwrap();
        let _mock = MockHost::start(&live_sock, &live, &s_live.host_token, MockMode::Normal);

        // dead session: stale socket file, nobody listening
        let dead = ids::new_id("ses");
        let mut s_dead = session(&dead, "prj_t5", Lifecycle::Running);
        let dead_sock = paths.socket_path(&dead);
        s_dead.host_socket = Some(dead_sock.to_string_lossy().into_owned());
        db.insert_session(&s_dead).unwrap();
        db.update_session_host(&dead, Some(999_999), Some(&dead_sock.to_string_lossy()))
            .unwrap();
        leave_stale_socket(&dead_sock);

        // status-events.jsonl for the dead session: seq1 (already in db),
        // seq2 (new), one garbage line, one line for another session.
        let ev = |seq: i64| StatusEvent {
            session_id: dead.clone(),
            run_id: LEGACY_RUN_ID.into(),
            run_ordinal: LEGACY_RUN_ORDINAL,
            sequence: seq,
            state: AgentState::Working,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some("hook:PreToolUse".into()),
            log_cursor: None,
            occurred_at: Utc::now(),
        };
        let event_one = ev(1);
        db.record_status_event(&event_one).unwrap();
        let dead_dir = paths.session_dir(&dead);
        std::fs::create_dir_all(&dead_dir).unwrap();
        let mut foreign = ev(7);
        foreign.session_id = "ses_other".into();
        let jsonl = format!(
            "{}\n{}\nnot json at all\n{}\n",
            serde_json::to_string(&event_one).unwrap(),
            serde_json::to_string(&ev(2)).unwrap(),
            serde_json::to_string(&foreign).unwrap(),
        );
        std::fs::write(dead_dir.join("status-events.jsonl"), jsonl).unwrap();

        let sessions = mgr.reconcile_on_startup().unwrap();
        assert_eq!(sessions.len(), 2);

        assert_eq!(
            db.get_session(&dead).unwrap().lifecycle,
            Lifecycle::Interrupted
        );
        assert!(
            dead_sock.exists(),
            "stable path is retained for a possible replacement host"
        );
        assert_eq!(
            db.get_session(&live).unwrap().lifecycle,
            Lifecycle::Running,
            "live host must stay running"
        );

        let hist = db.status_history(&dead, 10).unwrap();
        let seqs: Vec<i64> = hist.iter().map(|e| e.sequence).collect();
        assert_eq!(
            seqs,
            vec![1, 2],
            "seq1 idempotent, seq2 imported, rest skipped"
        );

        // second run is a no-op for events and never restarts anything
        mgr.reconcile_on_startup().unwrap();
        assert_eq!(db.status_history(&dead, 10).unwrap().len(), 2);
        assert_eq!(
            db.get_session(&dead).unwrap().lifecycle,
            Lifecycle::Interrupted
        );
    }

    #[test]
    fn reconcile_does_not_terminally_classify_a_live_pid_on_socket_failure() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().join("agentport"));
        let db = Db::open(&paths).unwrap();
        add_project(&db, "prj_live_pid");
        let id = ids::new_id("ses");
        let socket = paths.socket_path(&id);
        let mut session = session(&id, "prj_live_pid", Lifecycle::Running);
        session.host_socket = Some(socket.to_string_lossy().into_owned());
        db.insert_session(&session).unwrap();
        // This test process is certainly alive, but no Host serves the socket.
        // A transient transport failure must leave lifecycle authority intact.
        db.update_session_host(
            &id,
            Some(std::process::id() as i64),
            Some(&socket.to_string_lossy()),
        )
        .unwrap();

        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        mgr.reconcile_on_startup().unwrap();
        assert_eq!(db.get_session(&id).unwrap().lifecycle, Lifecycle::Running);
    }

    #[test]
    fn reconcile_verified_dead_host_creates_one_traceable_interruption_event() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_dead_event");
        let id = ids::new_id("ses");
        db.insert_session(&session(&id, "prj_dead_event", Lifecycle::Creating))
            .unwrap();
        let run = db.create_session_run(&id, "run_dead_event").unwrap();
        let socket = paths.socket_path(&id);
        let log = paths.run_log_path(&id, &run.run_id);
        db.claim_session_run(&id, &run.run_id, run.run_ordinal, &log.to_string_lossy())
            .unwrap();
        db.bind_session_host_for_run(
            &id,
            &run.run_id,
            run.run_ordinal,
            999_999,
            &socket.to_string_lossy(),
        )
        .unwrap();
        db.update_session_lifecycle_if_host(
            &id,
            999_999,
            Some((&run.run_id, run.run_ordinal)),
            Lifecycle::Running,
        )
        .unwrap();
        let last_log = LogCursor {
            run_id: run.run_id.clone(),
            run_ordinal: run.run_ordinal,
            generation: 3,
            offset: 42,
        };
        db.set_latest_log_cursor(&id, &last_log).unwrap();
        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        mgr.reconcile_on_startup().unwrap();
        let history = db.status_history(&id, 10).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].state, AgentState::Exited);
        assert_eq!(
            history[0].evidence.as_deref(),
            Some("host:interrupted:pid-dead")
        );
        assert_eq!(history[0].run_id, run.run_id);
        assert_eq!(history[0].run_ordinal, run.run_ordinal);
        assert_eq!(history[0].log_cursor.as_ref(), Some(&last_log));

        // Reopen/reconcile is idempotent: the terminal lifecycle transition
        // was the guard that emitted this recovery fact.
        mgr.reconcile_on_startup().unwrap();
        assert_eq!(db.status_history(&id, 10).unwrap().len(), 1);
    }

    // -- 6. launch failure: no binary -> exited, nothing left behind ------------

    #[test]
    fn launch_with_missing_binary_fails_clean() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_t6");
        let sid = ids::new_id("ses");
        let s = session(&sid, "prj_t6", Lifecycle::Creating);
        db.insert_session(&s).unwrap();

        std::env::set_var("AGENTPORT_HOST_BIN", "/nonexistent/agentport-host-zzz");
        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        let r = mgr.launch(LaunchSpec {
            session: s,
            command: vec!["/bin/cat".into()],
            env: vec![],
            secrets: vec![],
            log_limit_bytes: 200 * 1024 * 1024,
            agent_session_id_hint: None,
            cols: 80,
            rows: 24,
        });
        std::env::remove_var("AGENTPORT_HOST_BIN");

        let e = r.expect_err("launch must fail");
        assert!(matches!(e, CoreError::Host(_)), "got {e:?}");
        assert_eq!(
            db.get_session(&sid).unwrap().lifecycle,
            Lifecycle::Exited,
            "failed launch marks session exited"
        );
        assert!(!paths.socket_path(&sid).exists(), "no socket left behind");
        assert!(
            !paths.host_config_path(&sid).exists(),
            "no host.json left behind"
        );
    }

    #[test]
    fn host_state_and_reaper_are_fenced_to_their_pid_and_run() {
        let dir = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(dir.path().to_path_buf());
        paths.ensure_layout().unwrap();
        let db = Db::open(&paths).unwrap();
        add_project(&db, "prj_reaper");
        let sid = ids::new_id("ses");
        db.insert_session(&session(&sid, "prj_reaper", Lifecycle::Creating))
            .unwrap();

        let first = db.create_session_run(&sid, "run_first").unwrap();
        let first_log = paths.run_log_path(&sid, &first.run_id);
        db.claim_session_run(
            &sid,
            &first.run_id,
            first.run_ordinal,
            &first_log.to_string_lossy(),
        )
        .unwrap();
        let child = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 0.05"])
            .spawn()
            .unwrap();
        let first_pid = child.id() as i64;
        let socket = paths.socket_path(&sid);
        db.bind_session_host_for_run(
            &sid,
            &first.run_id,
            first.run_ordinal,
            first_pid,
            &socket.to_string_lossy(),
        )
        .unwrap();
        db.update_session_lifecycle_if_host(
            &sid,
            first_pid,
            Some((&first.run_id, first.run_ordinal)),
            Lifecycle::Running,
        )
        .unwrap();

        let state_path = paths.session_dir(&sid).join("host-state.json");
        std::fs::create_dir_all(state_path.parent().unwrap()).unwrap();
        std::fs::write(
            &state_path,
            serde_json::to_vec(&serde_json::json!({
                "session_id": &sid,
                "host_pid": first_pid,
                "run_id": &first.run_id,
                "run_ordinal": first.run_ordinal,
                "exited_at": Utc::now().to_rfc3339(),
                "exit_reason": "natural"
            }))
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            terminal_lifecycle_from_host_state(
                &paths,
                &sid,
                first_pid,
                Some((&first.run_id, first.run_ordinal)),
            ),
            Some(Lifecycle::Exited)
        );
        assert_eq!(
            terminal_lifecycle_from_host_state(
                &paths,
                &sid,
                first_pid + 1,
                Some((&first.run_id, first.run_ordinal)),
            ),
            None
        );

        // A replacement claims ownership before the first process is reaped.
        // The old reaper will later observe a valid terminal host-state file,
        // but its PID/run CAS must not alter this newer run.
        let second = db.create_session_run(&sid, "run_second").unwrap();
        let second_log = paths.run_log_path(&sid, &second.run_id);
        db.claim_session_run(
            &sid,
            &second.run_id,
            second.run_ordinal,
            &second_log.to_string_lossy(),
        )
        .unwrap();
        db.bind_session_host_for_run(
            &sid,
            &second.run_id,
            second.run_ordinal,
            424_242,
            &socket.to_string_lossy(),
        )
        .unwrap();
        db.update_session_lifecycle_if_host(
            &sid,
            424_242,
            Some((&second.run_id, second.run_ordinal)),
            Lifecycle::Running,
        )
        .unwrap();
        spawn_host_reaper(
            paths.clone(),
            sid.clone(),
            child,
            first.run_id.clone(),
            first.run_ordinal,
        );

        let deadline = Instant::now() + Duration::from_secs(1);
        while pid_alive(first_pid as i32) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        // Give the detached reaper a scheduling turn after the child exits.
        std::thread::sleep(Duration::from_millis(25));
        assert!(!pid_alive(first_pid as i32), "old host must have exited");
        assert_eq!(
            db.get_session(&sid).unwrap().lifecycle,
            Lifecycle::Running,
            "old reaper must not overwrite the replacement run"
        );
        assert_eq!(
            db.session_host_binding(&sid).unwrap(),
            SessionHostBinding {
                host_pid: Some(424_242),
                run_id: Some(second.run_id),
                run_ordinal: Some(second.run_ordinal),
            }
        );
    }

    // -- 7. handshake timeout ---------------------------------------------------

    #[test]
    fn connect_handshake_timeout_is_host_error() {
        let (_dir, paths, _db) = fixture();
        let sid = ids::new_id("ses");
        let token = ids::new_host_token();
        let sock = paths.socket_path(&sid);
        let _mock = MockHost::start(&sock, &sid, &token, MockMode::Silent);

        let start = Instant::now();
        let e = HostClient::connect(&sock.to_string_lossy(), &sid, &token, 0).unwrap_err();
        assert!(matches!(e, CoreError::Host(_)), "got {e:?}");
        assert!(
            start.elapsed() >= HANDSHAKE_TIMEOUT,
            "must actually wait for the handshake timeout"
        );
    }
}
