//! Host lifecycle manager (PRD 3.3, ch.6).
//!
//! The GUI/CLI never owns agent processes. This module spawns one
//! `agentport-host` process per session, hands it a HostConfig via a 0600
//! config file (no secrets — secrets go through the spawn environment only),
//! and speaks the handshake-verified socket protocol. Reconnects validate
//! session id + token every time; stale sockets are removed, never written to.

use crate::db::Db;
use crate::error::{CoreError, Result};
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

/// True while `pid` exists (kill(pid, 0) succeeds or fails with EPERM).
fn pid_alive(pid: i32) -> bool {
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Ok(()) => true,
        Err(nix::errno::Errno::ESRCH) => false,
        Err(_) => true,
    }
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

/// SIGTERM, wait 1s, then SIGKILL (PRD stop escalation).
fn force_kill(pid: i32) {
    use nix::sys::signal::{kill, Signal};
    let p = nix::unistd::Pid::from_raw(pid);
    let _ = kill(p, Some(Signal::SIGTERM));
    if wait_pid_gone(pid, Duration::from_secs(1)) {
        return;
    }
    let _ = kill(p, Some(Signal::SIGKILL));
    let _ = wait_pid_gone(pid, Duration::from_secs(1));
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
    pub host_pid: u32,
    pub child_alive: bool,
    pub log_bytes: u64,
    pub agent_session_id: Option<String>,
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
        let socket_path = self.paths.socket_path(&id);
        let socket_str = socket_path.to_string_lossy().into_owned();
        let config_path = self.paths.host_config_path(&id);
        let mut child: Option<Child> = None;

        let mut run = || -> Result<AttachInfo> {
            // Remove any stale socket file from a previous, dead host so the
            // new host can bind (a live host would never be re-launched).
            let _ = std::fs::remove_file(&socket_path);

            let bin = host_binary_path()?;

            let cfg = HostConfig {
                protocol: PROTOCOL_VERSION,
                session_id: id.clone(),
                host_token: session.host_token.clone(),
                command: spec.command.clone(),
                cwd: session.cwd.clone(),
                env: spec.env.clone(),
                adapter_type: session.adapter_type.as_str().to_string(),
                socket_path: socket_str.clone(),
                log_path: session.log_path.clone(),
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

            // Wait for the socket to appear; bail early if the host dies.
            let deadline = Instant::now() + SPAWN_READY_TIMEOUT;
            loop {
                if let Some(c) = child.as_mut() {
                    if let Some(status) = c.try_wait()? {
                        let tail = read_log_tail(&self.paths.host_log_path(&id), 4096);
                        return Err(CoreError::Host(format!(
                            "host exited during startup ({status}): {tail}"
                        )));
                    }
                }
                if socket_path.exists() {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err(CoreError::Host(format!(
                        "host did not create its socket within {}s",
                        SPAWN_READY_TIMEOUT.as_secs()
                    )));
                }
                std::thread::sleep(Duration::from_millis(50));
            }

            let (_client, info) = HostClient::connect(&socket_str, &id, &session.host_token, 0)?;
            drop(_client);
            self.db
                .update_session_host(&id, Some(child_pid as i64), Some(&socket_str))?;
            self.db.update_session_lifecycle(&id, Lifecycle::Running)?;
            Ok(info)
        };

        match run() {
            Ok(info) => {
                let child = child.take().expect("host spawned");
                spawn_host_reaper(self.paths.clone(), id, child);
                Ok(info)
            }
            Err(e) => {
                if let Some(c) = child.as_mut() {
                    let _ = c.kill();
                    let _ = c.wait();
                }
                let _ = std::fs::remove_file(&socket_path);
                let _ = std::fs::remove_file(&config_path);
                let _ = self.db.update_session_lifecycle(&id, Lifecycle::Exited);
                Err(e)
            }
        }
    }

    /// Attach to an already-running host (GUI reopen path). Verifies
    /// session id + token in the handshake; cleans up and reports stale
    /// sockets instead of writing input to them (PRD 3.3 failure C).
    pub fn attach(&self, session_id: &str) -> Result<(HostClient, AttachInfo)> {
        let session = self.db.get_session(session_id)?;
        let socket = match &session.host_socket {
            Some(s) if !s.is_empty() => s.clone(),
            _ => return Err(CoreError::Host("no host socket recorded".into())),
        };
        if session.host_token.is_empty() {
            return Err(CoreError::Host("no host token recorded".into()));
        }
        match HostClient::connect(&socket, session_id, &session.host_token, 0) {
            Ok(ok) => Ok(ok),
            Err(e @ CoreError::Protocol(_)) => Err(e),
            Err(CoreError::Host(_)) => {
                // Dead host: never write to a stale socket — remove it and
                // mark the session interrupted (PRD 3.3 failure C).
                let _ = std::fs::remove_file(&socket);
                let _ = self
                    .db
                    .update_session_lifecycle(session_id, Lifecycle::Interrupted);
                Err(CoreError::Host("stale host cleaned".into()))
            }
            Err(e) => Err(e),
        }
    }

    /// Graceful stop via socket `stop` frame; falls back to killing the host
    /// process group when the socket is dead. Verifies no descendants remain.
    pub fn stop(&self, session_id: &str, grace_ms: u64) -> Result<()> {
        let session = self.db.get_session(session_id)?;
        if matches!(session.lifecycle, Lifecycle::Stopped | Lifecycle::Exited) {
            return Ok(()); // idempotent
        }
        let pid = session.host_pid.filter(|p| *p > 0).map(|p| p as i32);
        match self.attach(session_id) {
            Ok((mut client, info)) => {
                // Stop frame sent; the host escalates SIGINT->SIGTERM->SIGKILL
                // on the child pgrp itself, reports Exit and exits. We do not
                // wait for the Exit frame here — the pid liveness check below
                // is the authoritative confirmation.
                let _ = client.request_stop(grace_ms);
                let host_pid = if info.host_pid > 0 {
                    Some(info.host_pid as i32)
                } else {
                    pid
                };
                match host_pid {
                    Some(p) => {
                        if !wait_pid_gone(p, Duration::from_millis(grace_ms + 3000)) {
                            force_kill(p);
                        }
                    }
                    // No pid to verify: the stop frame was delivered; give the
                    // host a moment to exit on its own.
                    None => std::thread::sleep(Duration::from_millis(100)),
                }
                self.db
                    .update_session_lifecycle(session_id, Lifecycle::Stopped)?;
                Ok(())
            }
            Err(CoreError::Host(_)) => {
                // Socket dead (attach already cleaned the stale file and marked
                // the session interrupted): kill the recorded pid directly.
                if let Some(p) = pid {
                    force_kill(p);
                }
                self.db
                    .update_session_lifecycle(session_id, Lifecycle::Stopped)?;
                Ok(())
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

    /// Startup reconciliation (PRD 3.3): for every session marked running,
    /// verify the host (socket handshake). Dead hosts -> lifecycle=interrupted,
    /// keep logs/metadata, remove stale socket files. Never auto-restart.
    pub fn reconcile_on_startup(&self) -> Result<Vec<Session>> {
        let candidates: Vec<Session> = self
            .db
            .list_sessions(None, false)?
            .into_iter()
            .filter(|s| matches!(s.lifecycle, Lifecycle::Creating | Lifecycle::Running))
            .collect();

        let mut out = Vec::with_capacity(candidates.len());
        for s in candidates {
            let check = match &s.host_socket {
                Some(sock) if !sock.is_empty() && !s.host_token.is_empty() => {
                    HostClient::connect(sock, &s.id, &s.host_token, 0).map(|_| ())
                }
                _ => Err(CoreError::Host("no host socket/token recorded".into())),
            };
            match check {
                Ok(()) => {}
                Err(CoreError::Host(_)) => {
                    if let Some(sock) = &s.host_socket {
                        let _ = std::fs::remove_file(sock);
                    }
                    self.db
                        .update_session_lifecycle(&s.id, Lifecycle::Interrupted)?;
                }
                Err(CoreError::Protocol(m)) => {
                    // Something answers but fails the identity check — not our
                    // host. Mark interrupted but do NOT remove the socket file
                    // (it may belong to a live, unrelated process).
                    tracing::warn!(session = %s.id, error = %m, "reconcile: handshake identity mismatch");
                    self.db
                        .update_session_lifecycle(&s.id, Lifecycle::Interrupted)?;
                }
                Err(e) => return Err(e),
            }
            let (_imported, skipped) = self.import_status_events(&s.id);
            if skipped > 0 {
                tracing::warn!(session = %s.id, skipped, "reconcile: skipped unparseable status-event lines");
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
        let Ok(s) = self.db.get_session(session_id) else {
            return false;
        };
        let Some(sock) = &s.host_socket else {
            return false;
        };
        if sock.is_empty() || s.host_token.is_empty() {
            return false;
        }
        HostClient::connect(sock, session_id, &s.host_token, 0).is_ok()
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
/// own exit record. A clean stop/natural agent exit writes `host-state.json`
/// with exit fields -> Exited; anything else (crash, SIGKILL) -> Interrupted
/// when the session was believed running (PRD 3.3 失败路径 B).
fn spawn_host_reaper(paths: AppPaths, session_id: String, mut child: Child) {
    std::thread::spawn(move || {
        let _ = child.wait(); // reaps the pid — no zombies, ever
        let state_path = paths.session_dir(&session_id).join("host-state.json");
        let clean_exit = std::fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .map(|v| v.get("exit_code").is_some() || v.get("signal").is_some())
            .unwrap_or(false);
        let Ok(db) = Db::open(&paths) else {
            return;
        };
        let Ok(session) = db.get_session(&session_id) else {
            return;
        };
        if matches!(session.lifecycle, Lifecycle::Creating | Lifecycle::Running) {
            let next = if clean_exit {
                Lifecycle::Exited
            } else {
                Lifecycle::Interrupted
            };
            let _ = db.update_session_lifecycle(&session_id, next);
        }
    });
}

/// A verified connection to a host. All frames carry the session id.
#[derive(Debug)]
pub struct HostClient {
    pub reader: BufReader<UnixStream>,
    pub writer: UnixStream,
    pub session_id: String,
    token: String,
}

impl HostClient {
    /// Connect + handshake; returns client + hello_ok info.
    pub fn connect(
        socket_path: &str,
        session_id: &str,
        token: &str,
        replay_tail_bytes: u64,
    ) -> Result<(Self, AttachInfo)> {
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
                protocol: PROTOCOL_VERSION,
                session_id: session_id.to_string(),
                token: token.to_string(),
                replay_tail_bytes,
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

        let info = match frame {
            HostFrame::HelloOk {
                protocol,
                session_id: sid,
                host_pid,
                child_alive,
                log_bytes,
                agent_session_id,
            } => {
                if protocol != PROTOCOL_VERSION {
                    return Err(CoreError::Protocol(format!(
                        "protocol version mismatch: host={protocol} core={PROTOCOL_VERSION}"
                    )));
                }
                if sid != session_id {
                    return Err(CoreError::Protocol(
                        "session id mismatch in hello_ok".into(),
                    ));
                }
                AttachInfo {
                    session_id: sid,
                    host_pid,
                    child_alive,
                    log_bytes,
                    agent_session_id,
                }
            }
            HostFrame::Error { message, .. } => return Err(CoreError::Protocol(message)),
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
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.write(&ClientFrame::Resize {
            session_id: self.session_id.clone(),
            cols,
            rows,
        })
    }
    pub fn interrupt(&mut self) -> Result<()> {
        self.write(&ClientFrame::Interrupt {
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
    /// Blocking read of one frame (None on EOF).
    pub fn read_frame(&mut self) -> Result<Option<HostFrame>> {
        crate::protocol::read_frame(&mut self.reader)
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
        let ok = matches!(
            &hello,
            Some(ClientFrame::Hello {
                session_id,
                token: t,
                ..
            }) if *session_id == sid && *t == token
        );
        if !ok {
            let _ = write_frame(
                &mut writer,
                &HostFrame::Error {
                    session_id: None,
                    message: "bad session id or token".into(),
                },
            );
            return;
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
                ClientFrame::Input { session_id, data } => {
                    if write_frame(
                        &mut writer,
                        &HostFrame::Output {
                            session_id,
                            data,
                            offset: 0,
                        },
                    )
                    .is_err()
                    {
                        return;
                    }
                }
                ClientFrame::Ping { session_id } => {
                    if write_frame(
                        &mut writer,
                        &HostFrame::Pong {
                            session_id,
                            at: Utc::now(),
                        },
                    )
                    .is_err()
                    {
                        return;
                    }
                }
                ClientFrame::Stop { session_id, .. } => {
                    let _ = write_frame(
                        &mut writer,
                        &HostFrame::Exit {
                            session_id,
                            code: Some(0),
                            signal: None,
                            group_cleaned: true,
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
            command: vec!["/bin/sh".into()],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
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

    // -- 3. attach to stale socket cleans up -----------------------------------

    #[test]
    fn attach_stale_socket_marks_interrupted_and_removes_file() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_t3");
        let sid = ids::new_id("ses");
        let sock = paths.socket_path(&sid);
        let mut s = session(&sid, "prj_t3", Lifecycle::Running);
        s.host_socket = Some(sock.to_string_lossy().into_owned());
        db.insert_session(&s).unwrap();
        leave_stale_socket(&sock);

        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        let e = mgr.attach(&sid).unwrap_err();
        assert!(matches!(e, CoreError::Host(_)), "got {e:?}");
        assert!(!sock.exists(), "stale socket file must be removed");
        assert_eq!(
            db.get_session(&sid).unwrap().lifecycle,
            Lifecycle::Interrupted
        );
    }

    // -- 4. stop is idempotent --------------------------------------------------

    #[test]
    fn stop_idempotent_for_non_running_sessions() {
        let (_dir, paths, db) = fixture();
        add_project(&db, "prj_t4");
        let mgr = HostManager {
            paths: &paths,
            db: &db,
        };
        for lc in [Lifecycle::Stopped, Lifecycle::Exited] {
            let sid = ids::new_id("ses");
            db.insert_session(&session(&sid, "prj_t4", lc)).unwrap();
            mgr.stop(&sid, 500).unwrap();
            assert_eq!(db.get_session(&sid).unwrap().lifecycle, lc);
        }
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
        let _mock = MockHost::start(&live_sock, &live, &s_live.host_token, MockMode::Normal);

        // dead session: stale socket file, nobody listening
        let dead = ids::new_id("ses");
        let mut s_dead = session(&dead, "prj_t5", Lifecycle::Running);
        let dead_sock = paths.socket_path(&dead);
        s_dead.host_socket = Some(dead_sock.to_string_lossy().into_owned());
        db.insert_session(&s_dead).unwrap();
        leave_stale_socket(&dead_sock);

        // status-events.jsonl for the dead session: seq1 (already in db),
        // seq2 (new), one garbage line, one line for another session.
        let ev = |seq: i64| StatusEvent {
            session_id: dead.clone(),
            sequence: seq,
            state: AgentState::Working,
            source: StateSource::Hook,
            confidence: Confidence::High,
            evidence: Some("hook:PreToolUse".into()),
            occurred_at: Utc::now(),
        };
        db.record_status_event(&ev(1)).unwrap();
        let dead_dir = paths.session_dir(&dead);
        std::fs::create_dir_all(&dead_dir).unwrap();
        let mut foreign = ev(7);
        foreign.session_id = "ses_other".into();
        let jsonl = format!(
            "{}\n{}\nnot json at all\n{}\n",
            serde_json::to_string(&ev(1)).unwrap(),
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
        assert!(!dead_sock.exists(), "dead socket file must be removed");
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

        let e = r.err().expect("launch must fail");
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
