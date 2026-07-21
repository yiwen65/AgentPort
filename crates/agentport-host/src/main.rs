//! agentport-host: one process per session (PRD 3.3, ch.6).
//!
//! Responsibilities:
//! - Read HostConfig from --config <path> (0600 json; NO secrets inside).
//! - Create a PTY (portable-pty), spawn the agent command as a NEW SESSION
//!   LEADER so the child pid == its process-group id; all signals target the
//!   whole group (PRD: 停止必须清理完整进程组).
//! - Append raw PTY bytes to output.log through the redacting LogWriter
//!   (rotation at the configured limit).
//! - Serve the Unix socket: handshake validates session id + host token,
//!   rejects everything else and closes. Broadcast output/state/heartbeat to
//!   all attached clients. Input frames re-validate the session id.
//! - Tail the hook-events file (JSON lines from CLI hooks) and feed the state
//!   machine together with PTY heuristics; emit state transitions.
//! - Capture the native agent session id when the adapter strategy allows
//!   (assigned hint, hook payload, or output parse) and report it.
//! - Stop flow: SIGINT pgrp -> grace -> SIGTERM pgrp -> grace -> SIGKILL pgrp;
//!   verify the group is gone (kill(pgid, 0) ESRCH), reap, write exit state,
//!   remove the socket, exit 0. A SIGTERM/SIGINT/SIGHUP to the HOST itself
//!   triggers the same group cleanup (never orphan the agent).
//! - Heartbeat frame every 1s + exit state persisted in the config dir.
//!
//! Implementation notes (verified against portable-pty 0.8.1):
//! - unix `spawn_command` runs `libc::setsid()` in `pre_exec`, so the child is
//!   a session leader and pgid == pid. There is a microseconds-wide race
//!   between `spawn` returning and the child's `pre_exec`; `verify_pgid`
//!   polls `getpgid(pid) == pid` for up to 2s before degrading to single-pid
//!   signaling (`pgid_verified=false` in host-state.json + host.log).
//! - The host owns the `Redactor` itself and hands `LogWriter` the already
//!   redacted bytes, so every broadcast `Output` chunk is byte-identical to
//!   what lands on disk and `WriteReceipt.offset` matches the log file
//!   exactly (sha256 consistency, PRD ch.10).
//! - The child is reaped exclusively via `nix::sys::wait::waitpid` (the
//!   portable-pty/std Child handle is never waited), giving exact
//!   code/signal for `Observation::ProcessExited` and the `Exit` frame.
//! - SIGKILL is only the last resort; it cannot be intercepted by the agent
//!   (documented behavior, PRD stop semantics).

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use agentport_core::logs::LogWriter;
use agentport_core::models::{AgentState, StatusEvent};
use agentport_core::protocol::{HostConfig, HostFrame};
use agentport_core::redact::Redactor;
use agentport_core::state::{Observation, PtyDetector, StateMachine};
use chrono::{DateTime, Utc};
use nix::errno::Errno;
use nix::sys::signal::{kill, killpg, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tracing::{error, info, warn};

mod server;

/// Exit codes (contract): 0 clean stop / child exit; 2 config invalid;
/// 3 pty/spawn failed; 4 socket bind failed. 64 = usage error.
const EXIT_OK: i32 = 0;
const EXIT_CONFIG: i32 = 2;
const EXIT_PTY: i32 = 3;
const EXIT_SOCKET: i32 = 4;

/// Messages from worker threads to the single control loop.
pub(crate) enum HostMsg {
    /// PTY / hook observations for the state machine.
    Obs(Observation),
    /// PTY reader hit EOF/EIO and finished the log writer.
    PtyEof,
    /// A client asked to stop the session.
    Stop { grace_ms: u64 },
    /// The host process itself received SIGTERM/SIGINT/SIGHUP.
    HostSignal(i32),
}

/// State shared with the socket server and worker threads.
pub(crate) struct Shared {
    cfg: HostConfig,
    /// `<session_dir>` = parent of `log_path` (host-state.json, events...).
    session_dir: PathBuf,
    started_at: DateTime<Utc>,
    child_pid: i32,
    pgid: i32,
    pgid_verified: bool,
    child_alive: AtomicBool,
    /// Bytes in the output log (mirrors `LogWriter::total_appended`).
    log_bytes: AtomicU64,
    last_output_at: Mutex<Instant>,
    /// Live-refreshed descendant snapshot so job-control escapees can be
    /// cleaned even after the leader dies and they reparent to init.
    known_descendants: Mutex<Vec<i32>>,
    agent_session_id: Mutex<Option<String>>,
    current_status: Mutex<Option<StatusEvent>>,
    clients: Mutex<HashMap<u64, mpsc::Sender<HostFrame>>>,
    next_client_id: AtomicU64,
    pty_writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
}

/// Broadcast a frame to all attached clients; dead clients are dropped.
pub(crate) fn broadcast(shared: &Shared, frame: &HostFrame) {
    let mut clients = shared.clients.lock().unwrap();
    clients.retain(|_, tx| tx.send(frame.clone()).is_ok());
}

pub(crate) fn status_frame(ev: &StatusEvent) -> HostFrame {
    HostFrame::State {
        session_id: ev.session_id.clone(),
        sequence: ev.sequence,
        state: ev.state,
        source: ev.source,
        confidence: ev.confidence,
        evidence: ev.evidence.clone(),
        occurred_at: ev.occurred_at,
    }
}

pub(crate) fn err_frame(session_id: Option<&str>, message: &str) -> HostFrame {
    HostFrame::Error {
        session_id: session_id.map(str::to_string),
        message: message.to_string(),
    }
}

/// Signal the whole agent process group, or just the child pid when pgid
/// verification failed at startup (degraded mode, PRD fallback).
pub(crate) fn signal_group(shared: &Shared, sig: Signal) {
    if shared.pgid_verified {
        let _ = killpg(Pid::from_raw(shared.pgid), sig);
    } else {
        let _ = kill(Pid::from_raw(shared.child_pid), sig);
    }
    // Job-control escapees: interactive shells put background jobs into their
    // own process groups. They stay descendants, so signal the whole tree.
    // (PRD: 停止必须清理完整进程组和所有后代进程.)
    for pid in descendant_pids(shared) {
        if pid != shared.child_pid {
            let _ = kill(Pid::from_raw(pid), sig);
        }
    }
}

/// Union of the live ppid tree below the child and the last-known descendant
/// snapshot (survives reparenting after the leader dies).
fn descendant_pids(shared: &Shared) -> Vec<i32> {
    let mut set: std::collections::BTreeSet<i32> =
        descendants_of(shared.child_pid).into_iter().collect();
    set.extend(shared.known_descendants.lock().unwrap().iter().copied());
    set.into_iter().collect()
}

/// Walk the process table (argv form, no shell) and collect every pid whose
/// ancestor chain reaches `root`. The host itself is never included.
pub(crate) fn descendants_of(root: i32) -> Vec<i32> {
    let out = match std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    let mut children: std::collections::HashMap<i32, Vec<i32>> = std::collections::HashMap::new();
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let mut it = line.split_whitespace();
        let (Some(Ok(pid)), Some(Ok(ppid))) =
            (it.next().map(str::parse), it.next().map(str::parse))
        else {
            continue;
        };
        children.entry(ppid).or_default().push(pid);
    }
    let mut out = vec![];
    let mut stack = vec![root];
    let me = std::process::id() as i32;
    while let Some(p) = stack.pop() {
        if let Some(kids) = children.get(&p) {
            for &k in kids {
                if k != me && !out.contains(&k) {
                    out.push(k);
                    stack.push(k);
                }
            }
        }
    }
    out
}

fn pid_alive(pid: i32) -> bool {
    !matches!(kill(Pid::from_raw(pid), None::<Signal>), Err(Errno::ESRCH))
}

/// No descendants of the session leader remain anywhere in the process table.
fn tree_gone(shared: &Shared) -> bool {
    if !descendants_of(shared.child_pid).is_empty() {
        return false;
    }
    !shared
        .known_descendants
        .lock()
        .unwrap()
        .iter()
        .any(|&p| pid_alive(p))
}

/// `kill(pgid, 0) == ESRCH` proves no process remains in the group.
fn group_gone(shared: &Shared) -> bool {
    matches!(
        kill(Pid::from_raw(-shared.pgid), None::<Signal>),
        Err(Errno::ESRCH)
    )
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--config" {
        eprintln!("usage: agentport-host --config <path>");
        return 64;
    }
    let raw = match std::fs::read_to_string(&args[2]) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("cannot read config {}: {e}", args[2]);
            return EXIT_CONFIG;
        }
    };
    let cfg: HostConfig = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot parse config {}: {e}", args[2]);
            return EXIT_CONFIG;
        }
    };
    if let Err(e) = validate_cfg(&cfg) {
        eprintln!("invalid config: {e}");
        return EXIT_CONFIG;
    }
    if let Err(e) = init_tracing(&cfg) {
        eprintln!("cannot open host log {}: {e}", cfg.host_log_path);
        return EXIT_CONFIG;
    }
    info!(session_id = %cfg.session_id, adapter = %cfg.adapter_type, "agentport-host starting");

    let session_dir = Path::new(&cfg.log_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    // Output log. The host holds the Redactor and feeds pre-redacted bytes to
    // the LogWriter (see module docs), so the writer needs no redactor itself.
    let log_path = PathBuf::from(&cfg.log_path);
    let log_writer = match LogWriter::open(&log_path, cfg.log_limit_bytes, None) {
        Ok(w) => w,
        Err(e) => {
            error!("open output log {} failed: {e}", cfg.log_path);
            return EXIT_CONFIG;
        }
    };
    let initial_log_bytes = log_writer.total_appended();

    // Secret values come ONLY from the host's own environment (PRD 3.7);
    // they are never logged — only the configured names are.
    let secrets: Vec<Vec<u8>> = cfg
        .secret_env_names
        .iter()
        .filter_map(|n| std::env::var(n).ok().map(String::into_bytes))
        .collect();
    let redactor = if secrets.is_empty() {
        None
    } else {
        Some(Redactor::new(secrets))
    };
    info!(
        secret_names = cfg.secret_env_names.len(),
        redactor_active = redactor.is_some(),
        "redactor ready"
    );

    // PTY + spawn.
    let pty_system = native_pty_system();
    let pair = match pty_system.openpty(PtySize {
        rows: cfg.rows,
        cols: cfg.cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(p) => p,
        Err(e) => {
            error!("openpty failed: {e}");
            return EXIT_PTY;
        }
    };
    let portable_pty::PtyPair { slave, master } = pair;

    let mut cmd = CommandBuilder::new(&cfg.command[0]);
    for a in &cfg.command[1..] {
        cmd.arg(a);
    }
    cmd.cwd(&cfg.cwd);
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }
    // Secrets are inherited through the environment, never the config file.
    for name in &cfg.secret_env_names {
        if let Ok(v) = std::env::var(name) {
            cmd.env(name, v);
        }
    }
    // The child runs inside AgentPort's xterm.js PTY, not the terminal that
    // launched the desktop app. GUI/debug launchers may carry TERM=dumb or
    // NO_COLOR=1, both of which make agent CLIs disable their TUI and colors.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env_remove("NO_COLOR");

    let child = match slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            error!("spawn {:?} failed: {e}", cfg.command[0]);
            return EXIT_PTY;
        }
    };
    // Close our copy of the slave so the reader sees EOF once the whole
    // agent process group is gone.
    drop(slave);
    let child_pid = child.process_id().map(|p| p as i32).unwrap_or(-1);

    let (pgid, pgid_verified) = verify_pgid(child_pid);
    info!(child_pid, pgid, pgid_verified, "agent spawned");
    if !pgid_verified {
        warn!("pgid != pid; degrading to single-pid signaling (group cleanup disabled)");
    }

    let pty_reader = match master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            error!("pty reader clone failed: {e}");
            return EXIT_PTY;
        }
    };
    let pty_writer = match master.take_writer() {
        Ok(w) => w,
        Err(e) => {
            error!("pty writer failed: {e}");
            return EXIT_PTY;
        }
    };

    // Unix socket (stale file removed first, mode 0600).
    let socket_path = PathBuf::from(&cfg.socket_path);
    if let Some(p) = socket_path.parent() {
        let _ = std::fs::create_dir_all(p);
    }
    let _ = std::fs::remove_file(&socket_path);
    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            error!("bind {} failed: {e}", cfg.socket_path);
            return EXIT_SOCKET;
        }
    };
    if let Err(e) = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)) {
        error!("chmod {} failed: {e}", cfg.socket_path);
        return EXIT_SOCKET;
    }

    let (msg_tx, msg_rx) = mpsc::channel::<HostMsg>();
    let shared = Arc::new(Shared {
        cfg: cfg.clone(),
        session_dir,
        started_at: Utc::now(),
        child_pid,
        pgid,
        pgid_verified,
        child_alive: AtomicBool::new(true),
        log_bytes: AtomicU64::new(initial_log_bytes),
        last_output_at: Mutex::new(Instant::now()),
        known_descendants: Mutex::new(vec![]),
        agent_session_id: Mutex::new(None),
        current_status: Mutex::new(None),
        clients: Mutex::new(HashMap::new()),
        next_client_id: AtomicU64::new(1),
        pty_writer: Mutex::new(pty_writer),
        master: Mutex::new(master),
    });

    write_host_state(&shared, None);

    // Native agent session id: launch hint wins over hook payloads (PRD 3.5).
    if let Some(hint) = cfg.agent_session_id_hint.clone() {
        info!("agent session id from launch hint");
        set_agent_session_id(&shared, &hint);
    }

    server::spawn_accept_loop(listener, shared.clone(), msg_tx.clone());
    spawn_pty_reader(
        pty_reader,
        log_writer,
        redactor,
        shared.clone(),
        msg_tx.clone(),
    );
    spawn_hook_poller(shared.clone(), msg_tx.clone());
    spawn_signal_handler(msg_tx.clone());

    // Keep the handle alive; reaping is done exclusively via waitpid (Reaper).
    let _child_handle = child;

    control_loop(&shared, msg_rx)
}

/// Minimal host-side validation. Deliberately does NOT enforce
/// `HostConfig::validate`'s 1 MiB log-limit floor so small limits stay usable
/// (e.g. rotation tests); the core enforces its own floor when writing configs.
fn validate_cfg(cfg: &HostConfig) -> Result<(), String> {
    if cfg.session_id.is_empty() {
        return Err("empty session_id".into());
    }
    if cfg.host_token.is_empty() {
        return Err("empty host_token".into());
    }
    if cfg.command.is_empty() || cfg.command[0].is_empty() {
        return Err("empty command".into());
    }
    if cfg.log_limit_bytes == 0 {
        return Err("zero log_limit_bytes".into());
    }
    Ok(())
}

fn init_tracing(cfg: &HostConfig) -> std::io::Result<()> {
    let path = Path::new(&cfg.host_log_path);
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p)?;
    }
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        opts.mode(0o600);
    }
    let file = Arc::new(opts.open(path)?);
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(file)
        .init();
    Ok(())
}

/// portable-pty (unix) calls setsid() in pre_exec, so the child becomes a
/// session leader with pgid == pid. Poll briefly to cross the fork->pre_exec
/// race window; on timeout report unverified.
fn verify_pgid(child_pid: i32) -> (i32, bool) {
    let mut last_pgid = -1;
    for _ in 0..40 {
        let g = unsafe { libc::getpgid(child_pid) };
        if g == child_pid {
            return (g, true);
        }
        if g > 0 {
            last_pgid = g;
        } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            break; // child already gone
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    (if last_pgid > 0 { last_pgid } else { child_pid }, false)
}

/// Reaps the agent leader via waitpid; nobody else may wait() on the child.
struct Reaper {
    pid: Pid,
    status: Option<(Option<i32>, Option<i32>)>,
}

impl Reaper {
    fn new(pid: i32) -> Self {
        Reaper {
            pid: Pid::from_raw(pid),
            status: None,
        }
    }

    fn done(&self) -> bool {
        self.status.is_some()
    }

    /// One non-blocking reap attempt; true once the leader is collected.
    fn poll(&mut self) -> bool {
        if self.status.is_some() {
            return true;
        }
        match waitpid(self.pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::Exited(_, c)) => self.status = Some((Some(c), None)),
            Ok(WaitStatus::Signaled(_, s, _)) => self.status = Some((None, Some(s as i32))),
            Ok(_) => {}
            Err(Errno::ECHILD) => self.status = Some((None, None)),
            Err(_) => {}
        }
        self.status.is_some()
    }

    fn reap_timeout(&mut self, timeout: Duration) -> (Option<i32>, Option<i32>) {
        let deadline = Instant::now() + timeout;
        while !self.poll() {
            if Instant::now() >= deadline {
                return (None, None);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.status.unwrap()
    }
}

/// Poll (50ms) until the process group AND the whole descendant tree are gone
/// (or the budget expires).
fn wait_dead(shared: &Shared, reaper: &mut Reaper, budget: Duration) -> bool {
    let deadline = Instant::now() + budget;
    loop {
        reaper.poll();
        let leader_dead = if shared.pgid_verified {
            group_gone(shared)
        } else {
            reaper.done()
        };
        if leader_dead && tree_gone(shared) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The single state-machine owner: observations in, status events out.
fn control_loop(shared: &Arc<Shared>, rx: mpsc::Receiver<HostMsg>) -> i32 {
    let mut sm = StateMachine::new(&shared.cfg.session_id);
    let mut status_file = open_status_file(&shared.session_dir);

    if let Some(ev) = sm.observe(Observation::ProcessSpawned) {
        emit_event(shared, &mut status_file, &ev);
    }

    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(HostMsg::Obs(obs)) => {
                if let Some(ev) = sm.observe(obs) {
                    emit_event(shared, &mut status_file, &ev);
                }
            }
            Ok(HostMsg::PtyEof) => return natural_exit(shared, &mut sm, &mut status_file),
            Ok(HostMsg::Stop { grace_ms }) => {
                return stop_flow(
                    shared,
                    &mut sm,
                    &mut status_file,
                    Some(grace_ms),
                    &rx,
                    "client_stop",
                )
            }
            Ok(HostMsg::HostSignal(sig)) => {
                info!(sig, "host received signal; cleaning up process group");
                return stop_flow(shared, &mut sm, &mut status_file, None, &rx, "host_signal");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => tick(shared, &mut sm, &mut status_file),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                error!("control channel disconnected");
                return stop_flow(shared, &mut sm, &mut status_file, None, &rx, "channel_lost");
            }
        }
    }
}

/// 1s tick: heartbeat broadcast + silence detection for the state machine +
/// descendant snapshot refresh (every 3rd tick, for tree cleanup).
fn tick(shared: &Shared, sm: &mut StateMachine, status_file: &mut Option<File>) {
    broadcast(
        shared,
        &HostFrame::Heartbeat {
            session_id: shared.cfg.session_id.clone(),
            at: Utc::now(),
            log_bytes: shared.log_bytes.load(Ordering::Relaxed),
        },
    );
    {
        use std::sync::atomic::AtomicU64;
        static TICKS: AtomicU64 = AtomicU64::new(0);
        if TICKS.fetch_add(1, Ordering::Relaxed) % 3 == 0 {
            *shared.known_descendants.lock().unwrap() = descendants_of(shared.child_pid);
        }
    }
    let elapsed = shared.last_output_at.lock().unwrap().elapsed();
    if elapsed > Duration::from_secs(3) {
        let working = matches!(
            shared
                .current_status
                .lock()
                .unwrap()
                .as_ref()
                .map(|e| e.state),
            Some(AgentState::Working)
        );
        if working {
            if let Some(ev) = sm.observe(Observation::PtySilence {
                ms: elapsed.as_millis() as u64,
            }) {
                emit_event(shared, status_file, &ev);
            }
        }
    }
}

/// Record + broadcast one status transition.
fn emit_event(shared: &Shared, status_file: &mut Option<File>, ev: &StatusEvent) {
    *shared.current_status.lock().unwrap() = Some(ev.clone());
    broadcast(shared, &status_frame(ev));
    if let Some(f) = status_file {
        if let Ok(line) = serde_json::to_string(ev) {
            let _ = f.write_all(line.as_bytes());
            let _ = f.write_all(b"\n");
            let _ = f.flush();
        }
    }
}

/// PRD 3.4 stop flow: SIGINT pgrp -> grace -> SIGTERM pgrp -> grace ->
/// SIGKILL pgrp -> verify kill(pgid,0)==ESRCH.
fn stop_flow(
    shared: &Arc<Shared>,
    sm: &mut StateMachine,
    status_file: &mut Option<File>,
    grace_override: Option<u64>,
    rx: &mpsc::Receiver<HostMsg>,
    reason: &str,
) -> i32 {
    info!(reason, "stop requested");
    let mut reaper = Reaper::new(shared.child_pid);
    if shared.child_alive.load(Ordering::Relaxed) {
        let sigint_ms = grace_override.unwrap_or(shared.cfg.sigint_grace_ms);
        for (sig, budget_ms) in [
            (Signal::SIGINT, sigint_ms),
            (Signal::SIGTERM, shared.cfg.sigterm_grace_ms),
            (Signal::SIGKILL, 2_000),
        ] {
            if sig == Signal::SIGKILL {
                warn!("process group still alive; escalating to SIGKILL (last resort)");
            }
            signal_group(shared, sig);
            if wait_dead(shared, &mut reaper, Duration::from_millis(budget_ms)) {
                break;
            }
        }
    }
    let (code, signal) = reaper.reap_timeout(Duration::from_secs(5));
    shared.child_alive.store(false, Ordering::Relaxed);
    let group_cleaned = shared.pgid_verified && group_gone(shared) && tree_gone(shared);
    if let Some(ev) = sm.observe(Observation::ProcessExited { code, signal }) {
        emit_event(shared, status_file, &ev);
    }
    broadcast(
        shared,
        &HostFrame::Exit {
            session_id: shared.cfg.session_id.clone(),
            code,
            signal,
            group_cleaned,
        },
    );
    info!(?code, ?signal, group_cleaned, "stop flow complete");
    // Let the PTY reader observe EOF and finish() the log before we leave.
    wait_pty_eof(rx, Duration::from_secs(2));
    // Give per-client writer threads a moment to flush the Exit frame.
    std::thread::sleep(Duration::from_millis(200));
    shutdown(shared, code, signal, group_cleaned);
    EXIT_OK
}

/// PRD 3.3: child exited on its own (PTY EOF/EIO) -> report, drain, exit 0.
/// Leftover background jobs (orphaned when the leader died) are cleaned up —
/// a finished session must not leave stray processes behind.
fn natural_exit(
    shared: &Arc<Shared>,
    sm: &mut StateMachine,
    status_file: &mut Option<File>,
) -> i32 {
    let mut reaper = Reaper::new(shared.child_pid);
    let (code, signal) = reaper.reap_timeout(Duration::from_secs(3));
    shared.child_alive.store(false, Ordering::Relaxed);
    // Clean up any descendants that survived the leader (best effort, using
    // the last snapshot taken before reparenting plus the live tree).
    for (sig, budget) in [(Signal::SIGTERM, 1_000u64), (Signal::SIGKILL, 1_000)] {
        if tree_gone(shared) {
            break;
        }
        for pid in descendant_pids(shared) {
            let _ = kill(Pid::from_raw(pid), sig);
        }
        let deadline = Instant::now() + Duration::from_millis(budget);
        while !tree_gone(shared) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    let group_cleaned = shared.pgid_verified && group_gone(shared) && tree_gone(shared);
    if let Some(ev) = sm.observe(Observation::ProcessExited { code, signal }) {
        emit_event(shared, status_file, &ev);
    }
    broadcast(
        shared,
        &HostFrame::Exit {
            session_id: shared.cfg.session_id.clone(),
            code,
            signal,
            group_cleaned,
        },
    );
    info!(
        ?code,
        ?signal,
        group_cleaned,
        "child exited; draining clients for 2s"
    );
    std::thread::sleep(Duration::from_secs(2));
    shutdown(shared, code, signal, group_cleaned);
    EXIT_OK
}

/// Drain control messages until the PTY reader reports EOF (log finished).
fn wait_pty_eof(rx: &mpsc::Receiver<HostMsg>, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            return;
        }
        match rx.recv_timeout(remain) {
            Ok(HostMsg::PtyEof) => return,
            Ok(_) => continue,
            Err(_) => return,
        }
    }
}

fn shutdown(shared: &Shared, code: Option<i32>, signal: Option<i32>, group_cleaned: bool) {
    let _ = std::fs::remove_file(&shared.cfg.socket_path);
    write_host_state(shared, Some((code, signal, group_cleaned)));
    info!("host shutdown complete");
}

/// `<session_dir>/host-state.json` (0600): startup facts + exit facts.
fn write_host_state(shared: &Shared, exit: Option<(Option<i32>, Option<i32>, bool)>) {
    let mut v = serde_json::json!({
        "pid": shared.child_pid,
        "host_pid": std::process::id(),
        "session_id": &shared.cfg.session_id,
        "socket_path": &shared.cfg.socket_path,
        "started_at": shared.started_at.to_rfc3339(),
        "pgid": shared.pgid,
        "pgid_verified": shared.pgid_verified,
    });
    if let Some((code, signal, cleaned)) = exit {
        v["exit_code"] = serde_json::json!(code);
        v["signal"] = serde_json::json!(signal);
        v["group_cleaned"] = serde_json::json!(cleaned);
        v["exited_at"] = serde_json::json!(Utc::now().to_rfc3339());
    }
    let path = shared.session_dir.join("host-state.json");
    match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut f) => {
            let _ = f.write_all(
                serde_json::to_string_pretty(&v)
                    .unwrap_or_default()
                    .as_bytes(),
            );
        }
        Err(e) => warn!("write host-state.json failed: {e}"),
    }
}

/// `<session_dir>/status-events.jsonl` (0600, append).
fn open_status_file(session_dir: &Path) -> Option<File> {
    let path = session_dir.join("status-events.jsonl");
    match OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(f) => Some(f),
        Err(e) => {
            error!("open status-events.jsonl failed: {e}");
            None
        }
    }
}

/// Record + broadcast the native agent session id (hint or hook source; both
/// yield "exact" resume precision per contract).
fn set_agent_session_id(shared: &Shared, id: &str) {
    {
        let mut cur = shared.agent_session_id.lock().unwrap();
        if cur.as_deref() == Some(id) {
            return;
        }
        *cur = Some(id.to_string());
    }
    let path = shared.session_dir.join("agent_session_id");
    match OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(mut f) => {
            let _ = f.write_all(id.as_bytes());
        }
        Err(e) => warn!("write agent_session_id failed: {e}"),
    }
    broadcast(
        shared,
        &HostFrame::AgentSession {
            session_id: shared.cfg.session_id.clone(),
            agent_session_id: id.to_string(),
            resume_precision: "exact".to_string(),
        },
    );
}

/// PTY reader thread: raw bytes -> redactor -> LogWriter -> broadcast Output
/// with the on-disk offset; feeds the PTY detector; finishes the log on EOF.
fn spawn_pty_reader(
    mut reader: Box<dyn Read + Send>,
    mut writer: LogWriter,
    redactor: Option<Redactor>,
    shared: Arc<Shared>,
    tx: mpsc::Sender<HostMsg>,
) {
    std::thread::spawn(move || {
        let mut detector = PtyDetector::new(&[], &[]);
        let mut redactor = redactor;
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    info!("pty EOF");
                    break;
                }
                Ok(n) => {
                    let chunk = &buf[..n];
                    *shared.last_output_at.lock().unwrap() = Instant::now();
                    let data = match &mut redactor {
                        Some(r) => r.feed(chunk),
                        None => chunk.to_vec(),
                    };
                    if !data.is_empty() {
                        match writer.append(&data) {
                            Ok(receipt) => {
                                shared
                                    .log_bytes
                                    .store(writer.total_appended(), Ordering::Relaxed);
                                if receipt.rotated {
                                    info!(generation = receipt.generation, "log rotated");
                                }
                                broadcast(
                                    &shared,
                                    &HostFrame::Output {
                                        session_id: shared.cfg.session_id.clone(),
                                        data,
                                        offset: receipt.offset,
                                    },
                                );
                            }
                            Err(e) => error!("log append failed: {e}"),
                        }
                    }
                    for obs in detector.feed(chunk) {
                        let _ = tx.send(HostMsg::Obs(obs));
                    }
                }
                Err(e) => {
                    // EIO = all slave fds closed (macOS/Linux); any read error
                    // is terminal for this session.
                    info!("pty read ended: {e}");
                    break;
                }
            }
        }
        // Flush the redactor's withheld tail so secrets never leak via the
        // final partial chunk.
        if let Some(r) = &mut redactor {
            let tail = r.finish();
            if !tail.is_empty() {
                match writer.append(&tail) {
                    Ok(receipt) => {
                        shared
                            .log_bytes
                            .store(writer.total_appended(), Ordering::Relaxed);
                        broadcast(
                            &shared,
                            &HostFrame::Output {
                                session_id: shared.cfg.session_id.clone(),
                                data: tail,
                                offset: receipt.offset,
                            },
                        );
                    }
                    Err(e) => error!("log append (tail) failed: {e}"),
                }
            }
            info!(redaction_hits = r.hits(), "redactor finished");
        }
        if let Err(e) = writer.finish() {
            error!("log finish failed: {e}");
        }
        let _ = tx.send(HostMsg::PtyEof);
    });
}

/// Hook-event poller: every 250ms consume new JSON lines from
/// `hook_events_path` ("event"/"hook_event_name"/"type" -> Hook observation;
/// "session_id"/"sessionId" -> native session id capture).
fn spawn_hook_poller(shared: Arc<Shared>, tx: mpsc::Sender<HostMsg>) {
    let path = PathBuf::from(&shared.cfg.hook_events_path);
    let hint_wins = shared.cfg.agent_session_id_hint.is_some();
    std::thread::spawn(move || {
        let mut offset: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue, // no hooks configured / not created yet
            };
            if meta.len() < offset {
                offset = 0; // truncated: start over
            }
            if meta.len() == offset {
                continue;
            }
            let mut f = match File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if f.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let mut buf = String::new();
            if f.read_to_string(&mut buf).is_err() {
                continue;
            }
            let mut consumed: u64 = 0;
            for line in buf.split_inclusive('\n') {
                if !line.ends_with('\n') {
                    break; // keep partial line for the next poll
                }
                consumed += line.len() as u64;
                let v: serde_json::Value = match serde_json::from_str(line.trim()) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(name) = ["event", "hook_event_name", "type"]
                    .iter()
                    .find_map(|k| v.get(*k))
                    .and_then(|x| x.as_str())
                {
                    let _ = tx.send(HostMsg::Obs(Observation::Hook(name.to_string())));
                }
                if !hint_wins {
                    if let Some(id) = ["session_id", "sessionId"]
                        .iter()
                        .find_map(|k| v.get(*k))
                        .and_then(|x| x.as_str())
                    {
                        if !id.is_empty() {
                            set_agent_session_id(&shared, id);
                        }
                    }
                }
            }
            offset += consumed;
        }
    });
}

/// Host-level signals run the same group cleanup as a client Stop.
fn spawn_signal_handler(tx: mpsc::Sender<HostMsg>) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    match signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) {
        Ok(mut sigs) => {
            std::thread::spawn(move || {
                for sig in sigs.forever() {
                    let _ = tx.send(HostMsg::HostSignal(sig));
                }
            });
        }
        Err(e) => error!("failed to register signal handlers: {e}"),
    }
}
