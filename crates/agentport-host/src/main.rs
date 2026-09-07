//! agentport-host: one process per session (PRD 3.3, ch.6).
//!
//! Responsibilities:
//! - Read HostConfig from --config <path> (0600 json; NO secrets inside).
//! - Create a PTY (portable-pty), spawn the agent command as a NEW SESSION
//!   LEADER so the child pid == its process-group id; all signals target the
//!   whole group (PRD: 停止必须清理完整进程组).
//! - Keep a redacted, bounded in-memory PTY tail for live reconnects. Agent
//!   conversation history is read on demand from each agent's native log;
//!   the Host never creates a duplicate output.log.
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
//! - The host owns the `Redactor` and applies it before bytes enter the live
//!   ring or a client frame. Offsets are monotonic within one Host run and do
//!   not claim durable storage.
//! - The child is reaped exclusively via `nix::sys::wait::waitpid` (the
//!   portable-pty/std Child handle is never waited), giving exact
//!   code/signal for `Observation::ProcessExited` and the `Exit` frame.
//! - SIGKILL is only the last resort; it cannot be intercepted by the agent
//!   (documented behavior, PRD stop semantics).

use std::collections::{HashMap, VecDeque};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixListener;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use agentport_core::adapters::adapter_for;
use agentport_core::models::{AgentState, AgentTransport, AgentType, LogCursor, StatusEvent};
use agentport_core::protocol::{encode_frame, HostConfig, HostFrame, TerminalGeometry};
use agentport_core::redact::Redactor;
use agentport_core::state::{Observation, PtyDetector, StateMachine};
use chrono::{DateTime, Utc};
use nix::errno::Errno;
use nix::sys::signal::{kill, killpg, Signal};
use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use nix::unistd::Pid;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tracing::{error, info, warn};

mod semantic_events;
mod server;

/// Exit codes (contract): 0 clean stop / child exit; 2 config invalid;
/// 3 pty/spawn failed; 4 socket bind failed. 64 = usage error.
const EXIT_OK: i32 = 0;
const EXIT_CONFIG: i32 = 2;
const EXIT_PTY: i32 = 3;
const EXIT_SOCKET: i32 = 4;
pub(crate) const LIVE_OUTPUT_TAIL_BYTES: usize = 4 * 1024 * 1024;

/// Bounded live terminal bytes. `start_offset..end_offset` names the retained
/// suffix of this Host run; bytes before `start_offset` are intentionally gone.
pub(crate) struct OutputTail {
    terminal_seed: agentport_core::terminal_seed::TerminalSeed,
    bytes: VecDeque<u8>,
    start_offset: u64,
    end_offset: u64,
}

impl OutputTail {
    fn new() -> Self {
        Self {
            terminal_seed: Default::default(),
            bytes: VecDeque::with_capacity(LIVE_OUTPUT_TAIL_BYTES),
            start_offset: 0,
            end_offset: 0,
        }
    }

    fn append(&mut self, data: &[u8]) -> u64 {
        self.terminal_seed.advance(data);
        let offset = self.end_offset;
        self.end_offset = self.end_offset.saturating_add(data.len() as u64);
        if data.len() >= LIVE_OUTPUT_TAIL_BYTES {
            self.bytes.clear();
            self.bytes
                .extend(data[data.len() - LIVE_OUTPUT_TAIL_BYTES..].iter().copied());
            self.start_offset = self.end_offset - LIVE_OUTPUT_TAIL_BYTES as u64;
            return offset;
        }
        let overflow = self
            .bytes
            .len()
            .saturating_add(data.len())
            .saturating_sub(LIVE_OUTPUT_TAIL_BYTES);
        if overflow > 0 {
            self.bytes.drain(..overflow);
            self.start_offset = self.start_offset.saturating_add(overflow as u64);
        }
        self.bytes.extend(data.iter().copied());
        offset
    }

    pub(crate) fn retained_start(&self) -> u64 {
        self.start_offset
    }

    pub(crate) fn retained_end(&self) -> u64 {
        self.end_offset
    }

    pub(crate) fn range_chunks(
        &self,
        start: u64,
        end: u64,
        chunk_size: usize,
    ) -> Option<Vec<Vec<u8>>> {
        if chunk_size == 0 || start < self.start_offset || start > end || end > self.end_offset {
            return None;
        }
        let skip = (start - self.start_offset) as usize;
        let take = (end - start) as usize;
        let mut source = self.bytes.iter().skip(skip).take(take);
        let mut chunks = Vec::with_capacity(take.div_ceil(chunk_size));
        loop {
            let chunk: Vec<u8> = source.by_ref().take(chunk_size).copied().collect();
            if chunk.is_empty() {
                break;
            }
            chunks.push(chunk);
        }
        Some(chunks)
    }
}

#[cfg(test)]
mod output_tail_tests {
    use super::{OutputTail, LIVE_OUTPUT_TAIL_BYTES};

    #[test]
    fn terminal_modes_survive_text_tail_eviction() {
        let mut tail = OutputTail::new();
        tail.append(b"\x1b[?1049h\x1b[?1003;1006h");
        tail.append(&vec![b'x'; LIVE_OUTPUT_TAIL_BYTES + 1]);
        assert_eq!(
            tail.terminal_seed.bytes(),
            b"\x1b[?1003h\x1b[?1006h\x1b[?1049h"
        );
        tail.append(b"\x1b[?1049l\x1b[?1003l");
        assert_eq!(tail.terminal_seed.bytes(), b"\x1b[?1003l\x1b[?1006h");
    }

    #[test]
    fn append_evicts_in_bulk_and_retains_exact_suffix() {
        let mut tail = OutputTail::new();
        let initial = vec![b'a'; LIVE_OUTPUT_TAIL_BYTES];
        tail.append(&initial);
        let replacement = (0..16 * 1024)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        tail.append(&replacement);

        assert_eq!(tail.retained_start(), replacement.len() as u64);
        assert_eq!(
            tail.retained_end(),
            (LIVE_OUTPUT_TAIL_BYTES + replacement.len()) as u64,
        );
        let chunks = tail
            .range_chunks(
                tail.retained_end() - replacement.len() as u64,
                tail.retained_end(),
                1024,
            )
            .unwrap();
        assert_eq!(chunks.concat(), replacement);
    }

    #[test]
    fn oversized_append_and_chunked_ranges_preserve_offsets_and_order() {
        let mut tail = OutputTail::new();
        let data = (0..LIVE_OUTPUT_TAIL_BYTES + 257)
            .map(|index| (index % 239) as u8)
            .collect::<Vec<_>>();
        assert_eq!(tail.append(&data), 0);
        assert_eq!(tail.retained_start(), 257);
        assert_eq!(tail.retained_end(), data.len() as u64);

        let start = tail.retained_start() + 123;
        let end = tail.retained_end() - 77;
        let chunks = tail.range_chunks(start, end, 64 * 1024).unwrap();
        assert!(chunks.iter().all(|chunk| chunk.len() <= 64 * 1024));
        assert_eq!(chunks.concat(), data[257 + 123..data.len() - 77].to_vec(),);
        assert!(tail.range_chunks(0, end, 1024).is_none());
        assert!(tail.range_chunks(start, end, 0).is_none());
    }
}

/// Messages from worker threads to the single control loop.
pub(crate) enum HostMsg {
    /// PTY or structured adapter observations for the state machine.
    Obs(Observation),
    /// Official hook observation with the hook file's write time. This fences
    /// a delayed completion against user input that already started a new turn.
    HookObs {
        name: String,
        completion_input_boundary: Option<SystemTime>,
    },
    /// Ordered native-log evidence that a main adapter turn completed. The
    /// final-record write boundary fences delayed completion against new input.
    SemanticCompletion {
        adapter: String,
        completion_input_boundary: Option<SystemTime>,
    },
    /// Ordered native-log evidence that a new adapter turn has started.
    SemanticActivity { adapter: String },
    /// PTY reader reached a clean EOF and finished the log writer.
    PtyEof,
    /// PTY reading failed before the control loop established that the child
    /// had exited. Treating this as ordinary EOF can strand a still-running
    /// agent after the Host exits, so it must enter the controlled stop flow.
    PtyFault { message: String },
    /// A client asked to stop the session.
    Stop { grace_ms: u64 },
    /// The host process itself received SIGTERM/SIGINT/SIGHUP.
    HostSignal(i32),
}

const SEMANTIC_IDLE_SHUTDOWN_DELAY: Duration = Duration::from_secs(15 * 60);
const ACTIVE_DESCENDANT_REFRESH_TICKS: u64 = 3;
const IDLE_DESCENDANT_REFRESH_TICKS: u64 = 60;

struct SemanticIdleShutdown {
    deadline: Option<Instant>,
    armed_user_activity_generation: u64,
    delay: Duration,
}

impl SemanticIdleShutdown {
    fn new(delay: Duration) -> Self {
        Self {
            deadline: None,
            armed_user_activity_generation: 0,
            delay,
        }
    }

    fn at_host_start(
        delay: Duration,
        now: Instant,
        user_activity_generation: u64,
        inherited_turn_complete: bool,
    ) -> Self {
        let mut shutdown = Self::new(delay);
        if inherited_turn_complete {
            shutdown.arm(now, user_activity_generation);
        }
        shutdown
    }

    fn arm(&mut self, now: Instant, user_activity_generation: u64) {
        self.deadline = Some(now + self.delay);
        self.armed_user_activity_generation = user_activity_generation;
    }

    fn cancel(&mut self) -> bool {
        self.deadline.take().is_some()
    }

    fn observe_user_activity(
        &mut self,
        generation: u64,
        now: Instant,
        requires_input_turn_fence: bool,
    ) -> bool {
        if self.deadline.is_none() || generation == self.armed_user_activity_generation {
            return false;
        }
        if requires_input_turn_fence {
            // Without guaranteed native live turn-start evidence, input must
            // fence cleanup for the whole new turn.
            self.cancel();
        } else {
            // Raw PTY input is not proof that a new turn started: xterm also
            // forwards terminal capability replies through the input stream.
            // Postpone the deadline; an authoritative semantic work event will
            // cancel it if this input really starts work.
            self.arm(now, generation);
        }
        true
    }

    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    fn due(&self, now: Instant) -> bool {
        self.deadline.is_some_and(|deadline| now >= deadline)
    }
}

/// State shared with the socket server and worker threads.
pub(crate) struct Shared {
    cfg: HostConfig,
    /// Stable Session root for host-state.json and status-events.jsonl.
    session_dir: PathBuf,
    /// Identity (dev, ino) of this Host's bound socket file, captured right
    /// after bind. A replacement Host that rebinds the stable path creates a
    /// different file, so a late orderly shutdown can leave the successor's
    /// directory entry in place instead of orphaning a live Host.
    socket_file_id: Option<(u64, u64)>,
    started_at: DateTime<Utc>,
    child_pid: i32,
    pgid: i32,
    pgid_verified: bool,
    child_alive: AtomicBool,
    process_suspended: AtomicBool,
    /// Total live output bytes observed during this Host run.
    log_bytes: AtomicU64,
    /// Current generation and byte position within that generation. These are
    /// updated when bytes enter the bounded live ring. The cursor is valid
    /// only while this Host remains alive.
    log_position: Mutex<(u64, u64)>,
    pub(crate) output_tail: Mutex<OutputTail>,
    /// Serializes PTY append/position/broadcast with reconnect high-water
    /// capture and registration. This is the boundary that makes every output
    /// chunk belong either to replay or to the subsequent live queue.
    output_serial: Mutex<()>,
    last_output_at: Mutex<Instant>,
    /// Live-refreshed descendant snapshot so job-control escapees can be
    /// cleaned even after the leader dies and they reparent to init.
    known_descendants: Mutex<Vec<i32>>,
    agent_session_id: Mutex<Option<String>>,
    current_status: Mutex<Option<StatusEvent>>,
    /// Set after a failed status-journal write so connected consumers receive
    /// one explicit degraded-persistence signal instead of silently trusting
    /// an in-memory-only state transition. A subsequent successful write
    /// clears the flag and permits a new signal for a later failure.
    status_journal_faulted: AtomicBool,
    clients: Mutex<HashMap<u64, server::ClientSink>>,
    next_client_id: AtomicU64,
    /// Connections that completed authentication, including a connection
    /// currently replaying or a writer draining after its reader exits.
    authenticated_client_count: AtomicUsize,
    /// Per-Host cadence counter for periodic descendant refreshes. This must
    /// not be global: otherwise activity in one session changes the cleanup
    /// cadence of every other Host process.
    tick_count: AtomicU64,
    /// Monotonic input generation. Socket readers update this without queueing
    /// one control message per keystroke; the one-second control tick observes
    /// changes and cancels a stale idle deadline.
    user_activity_generation: AtomicU64,
    /// Wall-clock input boundary compared with official hook-file mtimes. The
    /// comparison rejects a completion written before the next prompt.
    last_user_activity_at: Mutex<SystemTime>,
    /// Serializes admission from independent authenticated socket readers and
    /// therefore defines the only server receive order for terminal input.
    input_admission: Mutex<()>,
    next_input_sequence: AtomicU64,
    /// Bounded queue consumed by exactly one terminal writer thread.
    input_queue: mpsc::SyncSender<server::InputMutation>,
    /// A partial/failed PTY write makes the effect unknown. Fail closed for the
    /// remainder of this run rather than append later bytes to a torn command.
    input_failed: AtomicBool,
    /// Terminal bytes for PTY Sessions or UTF-8 JSONL commands for structured
    /// Pi Sessions. The socket server owns protocol-specific serialization.
    input_writer: Mutex<Box<dyn Write + Send>>,
    /// Only PTY Sessions support resize. Keeping this optional makes the pipe
    /// path structurally incapable of allocating a PTY.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    /// Run-local geometry authority shared by every authenticated attachment.
    /// It intentionally dies with the Host so a later run cannot inherit an
    /// old phone's ownership or revision.
    terminal_geometry: Mutex<TerminalGeometry>,
}

/// Keep the process handle in scope while the Host controls/reaps it through
/// waitpid. Dropping either variant does not become a lifecycle operation.
enum AgentChild {
    Pty(Box<dyn portable_pty::Child + Send + Sync>),
    Pipe(std::process::Child),
}

impl AgentChild {
    /// Touch the contained child so it remains intentionally retained for the
    /// lifetime of the Host; reaping itself is exclusively waitpid-based.
    fn retain_until_host_exit(&self) {
        match self {
            AgentChild::Pty(child) => {
                let _ = child.process_id();
            }
            AgentChild::Pipe(child) => {
                let _ = child.id();
            }
        }
    }
}

/// Broadcast a frame to all attached clients without letting one slow socket
/// stall the Host. Full or disconnected client queues are evicted and their
/// `ClientSink` shuts down only that client's socket.
pub(crate) fn broadcast(shared: &Shared, frame: &HostFrame) {
    let mut evicted = Vec::new();
    let mut clients = shared.clients.lock().unwrap();
    let mut drop_ids = Vec::new();
    let is_output = matches!(
        frame,
        HostFrame::Output { .. } | HostFrame::TransientOutput { .. }
    );
    if !clients
        .values()
        .any(|client| !is_output || client.subscribe_output)
    {
        return;
    }
    let encoded = match encode_frame(frame) {
        Ok(encoded) => Arc::new(encoded),
        Err(error) => {
            error!(%error, "could not encode Host broadcast frame");
            return;
        }
    };
    for (&id, client) in clients.iter() {
        if is_output && !client.subscribe_output {
            continue;
        }
        match client
            .tx
            .try_send(server::OutboundFrame::Data(encoded.clone()))
        {
            Ok(()) => {}
            Err(mpsc::TrySendError::Full(_)) => {
                drop_ids.push((id, "outbound queue full"));
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                drop_ids.push((id, "outbound queue disconnected"));
            }
        }
    }
    for (id, reason) in drop_ids {
        if let Some(client) = clients.remove(&id) {
            evicted.push((id, reason, client));
        }
    }
    drop(clients);
    for (id, reason, client) in evicted {
        warn!(client_id = id, reason, "dropping client from broadcast");
        client.close();
        drop(client);
    }
}

pub(crate) fn current_log_cursor(shared: &Shared) -> LogCursor {
    let (generation, offset) = *shared.log_position.lock().unwrap();
    LogCursor {
        run_id: shared.cfg.run_id.clone(),
        run_ordinal: shared.cfg.run_ordinal,
        generation: generation.min(i64::MAX as u64) as i64,
        offset: offset.min(i64::MAX as u64) as i64,
    }
}

pub(crate) fn status_frame(ev: &StatusEvent) -> HostFrame {
    HostFrame::State {
        session_id: ev.session_id.clone(),
        run_id: ev.run_id.clone(),
        run_ordinal: ev.run_ordinal,
        sequence: ev.sequence,
        state: ev.state,
        source: ev.source,
        confidence: ev.confidence,
        evidence: ev.evidence.clone(),
        log_cursor: ev.log_cursor.clone(),
        occurred_at: ev.occurred_at,
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum HostErrorCode {
    StatusJournalFailed,
    SessionIdMismatch,
    TerminalInputUnavailable,
    StructuredPromptTransportRequired,
    StructuredPromptEmpty,
    StructuredAbortTransportRequired,
    DuplicateHello,
    HandshakeRejected,
}

impl HostErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::StatusJournalFailed => "host_status_journal_failed",
            Self::SessionIdMismatch => "host_session_id_mismatch",
            Self::TerminalInputUnavailable => "host_terminal_input_unavailable",
            Self::StructuredPromptTransportRequired => "host_structured_prompt_transport_required",
            Self::StructuredPromptEmpty => "host_structured_prompt_empty",
            Self::StructuredAbortTransportRequired => "host_structured_abort_transport_required",
            Self::DuplicateHello => "host_duplicate_hello",
            Self::HandshakeRejected => "host_handshake_rejected",
        }
    }
}

pub(crate) fn err_frame(session_id: Option<&str>, code: HostErrorCode, message: &str) -> HostFrame {
    HostFrame::Error {
        session_id: session_id.map(str::to_string),
        message: message.to_string(),
        code: Some(code.as_str().into()),
        params: Some(serde_json::json!({})),
        technical_detail: Some(message.to_string()),
    }
}

pub(crate) fn note_user_activity(shared: &Shared) {
    let mut last_user_activity_at = shared.last_user_activity_at.lock().unwrap();
    *last_user_activity_at = SystemTime::now();
    // Keep timestamp and generation under one lock so completion can capture
    // a generation that belongs to the exact timestamp comparison it made.
    shared
        .user_activity_generation
        .fetch_add(1, Ordering::Relaxed);
}

/// Signal the whole agent process group, or just the child pid when pgid
/// verification failed at startup (degraded mode, PRD fallback).
pub(crate) fn signal_group(shared: &Shared, sig: Signal) -> bool {
    let primary_delivered = if shared.pgid_verified {
        killpg(Pid::from_raw(shared.pgid), sig).is_ok()
    } else {
        kill(Pid::from_raw(shared.child_pid), sig).is_ok()
    };
    // Job-control escapees: interactive shells put background jobs into their
    // own process groups. They stay descendants, so signal the whole tree.
    // (PRD: 停止必须清理完整进程组和所有后代进程.)
    for pid in descendant_pids(shared) {
        if pid != shared.child_pid {
            let _ = kill(Pid::from_raw(pid), sig);
        }
    }
    primary_delivered
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

/// True while the agent leader still exists. This is deliberately separate
/// from `child_alive`: the latter is the Host's lifecycle classification and
/// is only flipped after reaping, whereas PTY EOF/error handling needs a
/// process-table fact before it commits to a natural exit.
fn leader_alive(pid: i32) -> bool {
    matches!(
        kill(Pid::from_raw(pid), None::<Signal>),
        Ok(()) | Err(Errno::EPERM)
    )
}

#[cfg(target_os = "macos")]
const DEFAULT_UTF8_CTYPE: &str = "UTF-8";
#[cfg(not(target_os = "macos"))]
const DEFAULT_UTF8_CTYPE: &str = "C.UTF-8";

fn default_utf8_ctype(cfg: &HostConfig) -> Option<&'static str> {
    const LOCALE_NAMES: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];
    let configured = LOCALE_NAMES
        .iter()
        .any(|name| cfg.env.iter().any(|(key, _)| key == name) || std::env::var_os(name).is_some());
    (!configured).then_some(DEFAULT_UTF8_CTYPE)
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

    let session_dir = if cfg.session_dir.trim().is_empty() {
        Path::new(&cfg.log_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."))
    } else {
        PathBuf::from(&cfg.session_dir)
    };

    // Secret values come ONLY from the host's own environment (PRD 3.7);
    // they are never logged — only the configured names are.
    let secrets: Vec<Vec<u8>> = cfg
        .secret_env_names
        .iter()
        .filter_map(|n| std::env::var(n).ok().map(String::into_bytes))
        .collect();
    // RPC events are parsed before they reach the structured UI, so redact
    // string leaves independently of the streaming terminal redactor.
    let structured_secret_text: Vec<String> = secrets
        .iter()
        .filter_map(|value| std::str::from_utf8(value).ok().map(str::to_owned))
        .filter(|value| !value.is_empty())
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

    // Unix socket (stale file removed first, mode 0600). Bind before spawn so
    // bind/chmod failures cannot leave an unowned child process behind.
    let socket_path = PathBuf::from(&cfg.socket_path);
    if let Some(p) = socket_path.parent() {
        if let Err(e) = std::fs::create_dir_all(p) {
            error!("create socket directory {} failed: {e}", p.display());
            return EXIT_SOCKET;
        }
    }
    let _ = std::fs::remove_file(&socket_path);
    let listener = match UnixListener::bind(&socket_path) {
        Ok(l) => l,
        Err(e) => {
            error!("bind {} failed before spawn: {e}", cfg.socket_path);
            return EXIT_SOCKET;
        }
    };
    if let Err(e) = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600)) {
        error!("chmod {} failed before spawn: {e}", cfg.socket_path);
        let _ = std::fs::remove_file(&socket_path);
        return EXIT_SOCKET;
    }
    // Remember which file this Host bound. Every later cleanup may only
    // unlink the path while it still names THIS binding; a successor Host
    // may have rebound the stable path by then.
    let socket_file_id = socket_file_id(&socket_path);

    // Adapter hooks append to a Session-stable file. Snapshot its length
    // before the new child can write so this run consumes only its own new
    // events; a later truncation is still handled by the poller.
    let hook_snapshot = HookSnapshot::capture(&cfg);
    let semantic_snapshot = semantic_events::Snapshot::capture(&cfg);
    let inherited_turn_complete =
        hook_snapshot.inherited_turn_complete || semantic_snapshot.inherited_turn_complete();

    // PTY remains the compatibility transport. Pi's structured RPC mode uses
    // ordinary pipes exclusively so terminal control bytes and TUI prompts
    // can never leak into its JSONL protocol.
    let utf8_ctype = default_utf8_ctype(&cfg);
    #[allow(clippy::type_complexity)]
    let (input_writer, output_reader, master, child_pid, agent_child, pipe_stderr): (
        Box<dyn Write + Send>,
        Box<dyn Read + Send>,
        Option<Box<dyn MasterPty + Send>>,
        i32,
        AgentChild,
        Option<Box<dyn Read + Send>>,
    ) = match cfg.transport {
        AgentTransport::Pty => {
            let pty_system = native_pty_system();
            let pair = match pty_system.openpty(PtySize {
                rows: cfg.rows,
                cols: cfg.cols,
                pixel_width: 0,
                pixel_height: 0,
            }) {
                Ok(pair) => pair,
                Err(e) => {
                    error!("openpty failed: {e}");
                    let _ = std::fs::remove_file(&socket_path);
                    return EXIT_PTY;
                }
            };
            let portable_pty::PtyPair { slave, master } = pair;
            let reader = match master.try_clone_reader() {
                Ok(reader) => reader,
                Err(e) => {
                    error!("pty reader clone failed before spawn: {e}");
                    let _ = std::fs::remove_file(&socket_path);
                    return EXIT_PTY;
                }
            };
            let writer = match master.take_writer() {
                Ok(writer) => writer,
                Err(e) => {
                    error!("pty writer setup failed before spawn: {e}");
                    let _ = std::fs::remove_file(&socket_path);
                    return EXIT_PTY;
                }
            };
            let mut command = CommandBuilder::new(&cfg.command[0]);
            // The Agent inherits the Host's full environment (which itself
            // carries the GUI/launchd environment); cfg.env overlays the
            // materialized login-shell environment, and named Secrets follow.
            for arg in &cfg.command[1..] {
                command.arg(arg);
            }
            command.cwd(&cfg.cwd);
            for (key, value) in &cfg.env {
                command.env(key, value);
            }
            for name in &cfg.secret_env_names {
                if let Ok(value) = std::env::var(name) {
                    command.env(name, value);
                }
            }
            if let Some(locale) = utf8_ctype {
                // Finder/LaunchServices apps commonly start without locale
                // variables. macOS clipboard tools then decode UTF-8 terminal
                // text as MacRoman. Match a UTF-8 terminal's baseline while
                // preserving every explicitly configured/inherited locale.
                command.env("LC_CTYPE", locale);
            }
            // The child runs inside AgentPort's xterm.js PTY, not the terminal
            // that launched the desktop app.
            command.env("TERM", "xterm-256color");
            command.env("COLORTERM", "truecolor");
            // AgentPort's xterm handles OSC 8 links. Advertise that capability
            // so Ink-based CLIs render `[label](url)` as a hidden hyperlink
            // instead of falling back to the visible `label (url)` form.
            command.env("FORCE_HYPERLINK", "1");
            command.env_remove("NO_COLOR");
            let mut child = match slave.spawn_command(command) {
                Ok(child) => child,
                Err(e) => {
                    error!("spawn {:?} failed: {e}", cfg.command[0]);
                    let _ = std::fs::remove_file(&socket_path);
                    return EXIT_PTY;
                }
            };
            drop(slave);
            let Some(pid) = child.process_id().map(|pid| pid as i32) else {
                error!("spawned PTY child did not provide a pid; terminating it defensively");
                let _ = child.kill();
                let _ = std::fs::remove_file(&socket_path);
                return EXIT_PTY;
            };
            (
                writer,
                reader,
                Some(master),
                pid,
                AgentChild::Pty(child),
                None,
            )
        }
        AgentTransport::JsonRpc => {
            let mut command = std::process::Command::new(&cfg.command[0]);
            command
                .args(&cfg.command[1..])
                .current_dir(&cfg.cwd)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            for (key, value) in &cfg.env {
                command.env(key, value);
            }
            for name in &cfg.secret_env_names {
                if let Ok(value) = std::env::var(name) {
                    command.env(name, value);
                }
            }
            if let Some(locale) = utf8_ctype {
                command.env("LC_CTYPE", locale);
            }
            // Process-group lifecycle is identical to PTY mode. `setsid` runs
            // in the child immediately before exec, so stop/interrupt signal
            // the entire Pi tool tree rather than just the shell wrapper.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(e) => {
                    error!("spawn RPC {:?} failed: {e}", cfg.command[0]);
                    let _ = std::fs::remove_file(&socket_path);
                    return EXIT_PTY;
                }
            };
            let pid = child.id() as i32;
            let Some(stdin) = child.stdin.take() else {
                let _ = child.kill();
                let _ = std::fs::remove_file(&socket_path);
                return EXIT_PTY;
            };
            let Some(stdout) = child.stdout.take() else {
                let _ = child.kill();
                let _ = std::fs::remove_file(&socket_path);
                return EXIT_PTY;
            };
            let stderr = child
                .stderr
                .take()
                .map(|stream| Box::new(stream) as Box<dyn Read + Send>);
            (
                Box::new(stdin),
                Box::new(stdout),
                None,
                pid,
                AgentChild::Pipe(child),
                stderr,
            )
        }
    };

    let (pgid, pgid_verified) = verify_pgid(child_pid);
    info!(child_pid, pgid, pgid_verified, "agent spawned");
    if !pgid_verified {
        warn!("pgid != pid; degrading to single-pid signaling (group cleanup disabled)");
    }

    let (msg_tx, msg_rx) = mpsc::channel::<HostMsg>();
    let (input_tx, input_rx) =
        mpsc::sync_channel::<server::InputMutation>(server::INPUT_QUEUE_CAPACITY);
    let shared = Arc::new(Shared {
        cfg: cfg.clone(),
        session_dir,
        socket_file_id,
        started_at: Utc::now(),
        child_pid,
        pgid,
        pgid_verified,
        child_alive: AtomicBool::new(true),
        process_suspended: AtomicBool::new(false),
        log_bytes: AtomicU64::new(0),
        log_position: Mutex::new((0, 0)),
        output_tail: Mutex::new(OutputTail::new()),
        output_serial: Mutex::new(()),
        last_output_at: Mutex::new(Instant::now()),
        known_descendants: Mutex::new(vec![]),
        agent_session_id: Mutex::new(None),
        current_status: Mutex::new(None),
        status_journal_faulted: AtomicBool::new(false),
        clients: Mutex::new(HashMap::new()),
        next_client_id: AtomicU64::new(1),
        authenticated_client_count: AtomicUsize::new(0),
        tick_count: AtomicU64::new(0),
        user_activity_generation: AtomicU64::new(0),
        last_user_activity_at: Mutex::new(SystemTime::UNIX_EPOCH),
        input_admission: Mutex::new(()),
        next_input_sequence: AtomicU64::new(1),
        input_queue: input_tx,
        input_failed: AtomicBool::new(false),
        input_writer: Mutex::new(input_writer),
        master: Mutex::new(master),
        terminal_geometry: Mutex::new(TerminalGeometry {
            run_id: cfg.run_id.clone(),
            run_ordinal: cfg.run_ordinal,
            cols: cfg.cols,
            rows: cfg.rows,
            source_kind: "desktop".into(),
            source_device_id: None,
            attachment_id: None,
            orientation: None,
            revision: 0,
            updated_at: Utc::now(),
        }),
    });

    write_host_state(&shared, None);
    // Capture before the socket accept loop starts. Input that races Host
    // startup must differ from this generation and cancel inherited idle state.
    let startup_user_activity_generation = shared.user_activity_generation.load(Ordering::Relaxed);

    // Native agent session id: launch hint wins over hook payloads (PRD 3.5).
    if let Some(hint) = cfg.agent_session_id_hint.clone() {
        info!("agent session id from launch hint");
        set_agent_session_id(&shared, &hint);
    }

    semantic_events::spawn(semantic_snapshot, shared.clone(), msg_tx.clone());

    server::spawn_input_worker(shared.clone(), input_rx);
    server::spawn_accept_loop(listener, shared.clone(), msg_tx.clone());
    match cfg.transport {
        AgentTransport::Pty => {
            spawn_pty_reader(output_reader, redactor, shared.clone(), msg_tx.clone())
        }
        AgentTransport::JsonRpc => {
            // Pi allocates its native ID during startup. Request state before
            // accepting user prompts and persist the reported ID via the
            // existing AgentSession HostFrame path.
            if let Err(error) =
                server::write_json_command(&shared, serde_json::json!({"type": "get_state"}))
            {
                let _ = msg_tx.send(HostMsg::PtyFault {
                    message: format!("Pi RPC get_state write failed: {error}"),
                });
            }
            spawn_rpc_reader(
                output_reader,
                structured_secret_text.clone(),
                shared.clone(),
                msg_tx.clone(),
            );
            if let Some(stderr) = pipe_stderr {
                spawn_rpc_stderr_reader(stderr, structured_secret_text, shared.clone());
            }
        }
    }
    spawn_hook_poller(shared.clone(), msg_tx.clone(), hook_snapshot.offset);
    spawn_signal_handler(msg_tx.clone());

    // Keep the handle alive; reaping is done exclusively via waitpid (Reaper).
    let _child_handle = agent_child;
    _child_handle.retain_until_host_exit();

    control_loop(
        &shared,
        msg_rx,
        inherited_turn_complete,
        startup_user_activity_generation,
    )
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
    suspended: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessWaitEvent {
    Suspended(i32),
    Continued,
    Exited,
}

impl Reaper {
    fn new(pid: i32) -> Self {
        Reaper {
            pid: Pid::from_raw(pid),
            status: None,
            suspended: false,
        }
    }

    fn done(&self) -> bool {
        self.status.is_some()
    }

    /// Observe job-control and exit transitions without blocking. Exit status
    /// remains retained so the later EOF/stop flow reports the real cause.
    fn poll_event(&mut self) -> Option<ProcessWaitEvent> {
        if self.status.is_some() {
            return None;
        }
        let flags = WaitPidFlag::WNOHANG | WaitPidFlag::WUNTRACED | WaitPidFlag::WCONTINUED;
        match waitpid(self.pid, Some(flags)) {
            Ok(WaitStatus::Exited(_, c)) => {
                self.status = Some((Some(c), None));
                Some(ProcessWaitEvent::Exited)
            }
            Ok(WaitStatus::Signaled(_, s, _)) => {
                self.status = Some((None, Some(s as i32)));
                Some(ProcessWaitEvent::Exited)
            }
            Ok(WaitStatus::Stopped(_, signal)) => {
                self.suspended = true;
                Some(ProcessWaitEvent::Suspended(signal as i32))
            }
            Ok(WaitStatus::Continued(_)) if self.suspended => {
                self.suspended = false;
                Some(ProcessWaitEvent::Continued)
            }
            Ok(_) => None,
            Err(Errno::ECHILD) => {
                self.status = Some((None, None));
                Some(ProcessWaitEvent::Exited)
            }
            Err(_) => None,
        }
    }

    /// One non-blocking reap attempt; true once the leader is collected.
    fn poll(&mut self) -> bool {
        let _ = self.poll_event();
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

fn semantic_idle_cleanup_supported(adapter: &str) -> bool {
    matches!(adapter, "claude" | "codex" | "kimi" | "pi" | "qoder")
}

fn is_semantic_turn_complete(obs: &Observation, adapter: &str) -> bool {
    if !semantic_idle_cleanup_supported(adapter) {
        return false;
    }
    match obs {
        Observation::AdapterTurnEnd { adapter: observed } => observed == adapter,
        Observation::Hook(name) => {
            name == "Stop" && matches!(adapter, "claude" | "codex" | "qoder")
        }
        _ => false,
    }
}

/// A high-confidence working hook supersedes a previously completed turn.
/// PTY activity is intentionally excluded: idle TUIs may repaint periodically,
/// and user input has its own generation fence.
fn is_semantic_turn_activity(obs: &Observation, adapter: &str) -> bool {
    semantic_idle_cleanup_supported(adapter)
        && matches!(
            obs,
            Observation::Hook(name)
                if matches!(
                    name.as_str(),
                    "UserPromptSubmit"
                        | "PreToolUse"
                        | "PostToolUse"
                        | "PermissionRequest"
                        | "AskUserQuestion"
                        | "BeforeTool"
                )
        )
}

fn handle_observation(
    shared: &Shared,
    sm: &mut StateMachine,
    status_file: &mut Option<File>,
    idle_shutdown: &mut SemanticIdleShutdown,
    obs: Observation,
    completion_user_activity_generation: Option<u64>,
) {
    let semantic_turn_complete = completion_user_activity_generation
        .filter(|_| is_semantic_turn_complete(&obs, &shared.cfg.adapter_type));
    if is_semantic_turn_activity(&obs, &shared.cfg.adapter_type) && idle_shutdown.cancel() {
        shared.tick_count.store(0, Ordering::Relaxed);
    }
    if let Some(ev) = sm.observe(obs) {
        emit_event(shared, status_file, ev);
    }
    if let Some(generation_at_turn_end) = semantic_turn_complete {
        // The generation was captured atomically with the producer-time
        // comparison. If input arrives while `ps` runs, the next loop cancels
        // this stale deadline before it can become due.
        *shared.known_descendants.lock().unwrap() = descendants_of(shared.child_pid);
        shared.tick_count.store(1, Ordering::Relaxed);
        idle_shutdown.arm(Instant::now(), generation_at_turn_end);
        info!(adapter = %shared.cfg.adapter_type, "semantic turn complete; idle shutdown armed");
    }
}

fn input_requires_turn_fence(adapter: &str, transport: AgentTransport) -> bool {
    transport == AgentTransport::JsonRpc || !matches!(adapter, "pi" | "kimi")
}

fn completion_generation_at_boundary(
    shared: &Shared,
    completion_input_boundary: Option<SystemTime>,
) -> Option<u64> {
    let observed_at = completion_input_boundary?;
    let last_user_activity_at = shared.last_user_activity_at.lock().unwrap();
    (*last_user_activity_at < observed_at)
        .then(|| shared.user_activity_generation.load(Ordering::Relaxed))
}

/// The single state-machine owner: observations in, status events out.
fn control_loop(
    shared: &Arc<Shared>,
    rx: mpsc::Receiver<HostMsg>,
    inherited_turn_complete: bool,
    startup_user_activity_generation: u64,
) -> i32 {
    let mut sm = StateMachine::for_run(
        &shared.cfg.session_id,
        &shared.cfg.run_id,
        shared.cfg.run_ordinal,
    );
    let mut status_file = open_status_file(&shared.session_dir);
    let mut reaper = Reaper::new(shared.child_pid);

    if let Some(ev) = sm.observe(Observation::ProcessSpawned) {
        emit_event(shared, &mut status_file, ev);
    }

    // `recv_timeout(1s)` on every iteration starves ticks when observations
    // are continuously queued: each immediate receive restarts the full
    // timeout. Keep an absolute deadline instead, so heartbeat/silence checks
    // remain wall-clock based under high-frequency PTY or hook activity.
    let tick_interval = Duration::from_secs(1);
    let mut next_tick = Instant::now() + tick_interval;
    let mut idle_shutdown = SemanticIdleShutdown::at_host_start(
        SEMANTIC_IDLE_SHUTDOWN_DELAY,
        Instant::now(),
        startup_user_activity_generation,
        inherited_turn_complete,
    );
    if inherited_turn_complete {
        info!(adapter = %shared.cfg.adapter_type, "resumed completed turn; idle shutdown armed");
    }

    loop {
        let now = Instant::now();
        let user_activity_generation = shared.user_activity_generation.load(Ordering::Relaxed);
        if idle_shutdown.observe_user_activity(
            user_activity_generation,
            now,
            input_requires_turn_fence(&shared.cfg.adapter_type, shared.cfg.transport),
        ) {
            shared.tick_count.store(0, Ordering::Relaxed);
        }
        if now >= next_tick {
            tick(
                shared,
                &mut sm,
                &mut status_file,
                &mut reaper,
                idle_shutdown.deadline().is_some(),
            );
            next_tick += tick_interval;
            // Avoid a burst of catch-up heartbeats if a slow state operation
            // took longer than a tick interval. Subsequent ticks resume from
            // the current wall-clock time rather than being starved forever.
            if next_tick <= Instant::now() {
                next_tick = Instant::now() + tick_interval;
            }
            continue;
        }

        let wake_at = idle_shutdown
            .deadline()
            .map_or(next_tick, |deadline| deadline.min(next_tick));
        match rx.recv_timeout(wake_at.saturating_duration_since(now)) {
            Ok(HostMsg::Obs(obs)) => {
                let completion_generation = matches!(
                    obs,
                    Observation::AdapterTurnEnd { ref adapter } if adapter == "pi"
                )
                .then(|| shared.user_activity_generation.load(Ordering::Relaxed));
                handle_observation(
                    shared,
                    &mut sm,
                    &mut status_file,
                    &mut idle_shutdown,
                    obs,
                    completion_generation,
                )
            }
            Ok(HostMsg::HookObs {
                name,
                completion_input_boundary,
            }) => {
                let completion_generation =
                    completion_generation_at_boundary(shared, completion_input_boundary);
                handle_observation(
                    shared,
                    &mut sm,
                    &mut status_file,
                    &mut idle_shutdown,
                    Observation::Hook(name),
                    completion_generation,
                );
            }
            Ok(HostMsg::SemanticCompletion {
                adapter,
                completion_input_boundary,
            }) => {
                let completion_generation =
                    completion_generation_at_boundary(shared, completion_input_boundary);
                handle_observation(
                    shared,
                    &mut sm,
                    &mut status_file,
                    &mut idle_shutdown,
                    Observation::AdapterTurnEnd { adapter },
                    completion_generation,
                );
            }
            Ok(HostMsg::SemanticActivity { adapter }) => {
                if adapter == shared.cfg.adapter_type && idle_shutdown.cancel() {
                    shared.tick_count.store(0, Ordering::Relaxed);
                }
            }
            Ok(HostMsg::PtyEof) => {
                return natural_exit(shared, &mut sm, &mut status_file, &rx, &mut reaper)
            }
            Ok(HostMsg::PtyFault { message }) => {
                warn!(error = %message, "pty reader failed; entering controlled stop flow");
                return stop_flow(
                    shared,
                    &mut sm,
                    &mut status_file,
                    None,
                    &rx,
                    "pty_fault",
                    &mut reaper,
                );
            }
            Ok(HostMsg::Stop { grace_ms }) => {
                return stop_flow(
                    shared,
                    &mut sm,
                    &mut status_file,
                    Some(grace_ms),
                    &rx,
                    "client_stop",
                    &mut reaper,
                )
            }
            Ok(HostMsg::HostSignal(sig)) => {
                info!(sig, "host received signal; cleaning up process group");
                return stop_flow(
                    shared,
                    &mut sm,
                    &mut status_file,
                    None,
                    &rx,
                    "host_signal",
                    &mut reaper,
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let generation = shared.user_activity_generation.load(Ordering::Relaxed);
                let now = Instant::now();
                if idle_shutdown.observe_user_activity(
                    generation,
                    now,
                    input_requires_turn_fence(&shared.cfg.adapter_type, shared.cfg.transport),
                ) {
                    shared.tick_count.store(0, Ordering::Relaxed);
                    continue;
                }
                if idle_shutdown.due(now) {
                    return stop_flow(
                        shared,
                        &mut sm,
                        &mut status_file,
                        None,
                        &rx,
                        "semantic_turn_complete",
                        &mut reaper,
                    );
                }
                // The next loop iteration observes the due tick deadline.
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                error!("control channel disconnected");
                return stop_flow(
                    shared,
                    &mut sm,
                    &mut status_file,
                    None,
                    &rx,
                    "channel_lost",
                    &mut reaper,
                );
            }
        }
    }
}

/// 1s tick: heartbeat broadcast + silence detection for the state machine +
/// descendant snapshots. Active turns refresh every 3s; a semantically
/// completed turn takes one immediate snapshot, then uses a 60s defensive
/// cadence while idle.
fn descendant_refresh_due(tick_count: u64, idle_grace: bool) -> bool {
    let interval = if idle_grace {
        IDLE_DESCENDANT_REFRESH_TICKS
    } else {
        ACTIVE_DESCENDANT_REFRESH_TICKS
    };
    tick_count.checked_rem(interval) == Some(0)
}

fn tick(
    shared: &Shared,
    sm: &mut StateMachine,
    status_file: &mut Option<File>,
    reaper: &mut Reaper,
    idle_grace: bool,
) {
    broadcast(
        shared,
        &HostFrame::Heartbeat {
            session_id: shared.cfg.session_id.clone(),
            at: Utc::now(),
            log_bytes: shared.log_bytes.load(Ordering::Relaxed),
            log_cursor: current_log_cursor(shared),
        },
    );
    match reaper.poll_event() {
        Some(ProcessWaitEvent::Suspended(signal)) => {
            shared.process_suspended.store(true, Ordering::Release);
            broadcast(
                shared,
                &HostFrame::ProcessStatus {
                    session_id: shared.cfg.session_id.clone(),
                    suspended: true,
                    signal: Some(signal),
                },
            )
        }
        Some(ProcessWaitEvent::Continued) => {
            shared.process_suspended.store(false, Ordering::Release);
            broadcast(
                shared,
                &HostFrame::ProcessStatus {
                    session_id: shared.cfg.session_id.clone(),
                    suspended: false,
                    signal: None,
                },
            )
        }
        Some(ProcessWaitEvent::Exited) | None => {}
    }
    if descendant_refresh_due(
        shared.tick_count.fetch_add(1, Ordering::Relaxed),
        idle_grace,
    ) {
        *shared.known_descendants.lock().unwrap() = descendants_of(shared.child_pid);
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
                emit_event(shared, status_file, ev);
            }
        }
    }
}

/// Persist then broadcast one status transition. The journal is the durable
/// recovery source; a client must never be told a state is authoritative
/// before its replay record has been flushed to disk.
fn emit_event(shared: &Shared, status_file: &mut Option<File>, mut ev: StatusEvent) {
    if ev.log_cursor.is_none() {
        ev.log_cursor = Some(current_log_cursor(shared));
    }
    let persistence_error = persist_status_event(status_file, &ev).err();
    if let Some(error) = persistence_error {
        error!(error = %error, sequence = ev.sequence, "status journal persistence failed");
        if !shared.status_journal_faulted.swap(true, Ordering::AcqRel) {
            broadcast(
                shared,
                &err_frame(
                    Some(&shared.cfg.session_id),
                    HostErrorCode::StatusJournalFailed,
                    "status journal persistence failed; state recovery is degraded",
                ),
            );
        }
    } else {
        shared
            .status_journal_faulted
            .store(false, Ordering::Release);
    }
    *shared.current_status.lock().unwrap() = Some(ev.clone());
    broadcast(shared, &status_frame(&ev));
}

/// Append a single event and force it through the OS before announcing it to
/// connected consumers. State transitions are low-frequency, so `sync_data`
/// is an intentional durability tradeoff rather than a high-rate output-path
/// cost.
fn persist_status_event(status_file: &mut Option<File>, ev: &StatusEvent) -> Result<(), String> {
    if let Some(f) = status_file {
        let line = serde_json::to_string(ev).map_err(|e| e.to_string())?;
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        f.write_all(b"\n").map_err(|e| e.to_string())?;
        f.flush().map_err(|e| e.to_string())?;
        f.sync_data().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("status-events.jsonl is not open".to_string())
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
    reaper: &mut Reaper,
) -> i32 {
    info!(reason, "stop requested");
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
            let _ = signal_group(shared, sig);
            if wait_dead(shared, reaper, Duration::from_millis(budget_ms)) {
                break;
            }
        }
    }
    let (code, signal) = reaper.reap_timeout(Duration::from_secs(5));
    shared.child_alive.store(false, Ordering::Relaxed);
    let group_cleaned = shared.pgid_verified && group_gone(shared) && tree_gone(shared);
    // A semantic TurnEnd is already the authoritative completed state. Do not
    // replace it with the signal used to retire the now-idle CLI: that
    // would misclassify a successful turn as a failed process exit.
    if reason != "semantic_turn_complete" {
        if let Some(ev) = sm.observe(Observation::ProcessExited { code, signal }) {
            emit_event(shared, status_file, ev);
        }
    }
    let exit_reason = match reason {
        "client_stop" => "user_stop",
        "host_signal" => "host_signal",
        "semantic_turn_complete" => "turn_complete",
        _ => "fault",
    };
    broadcast(
        shared,
        &HostFrame::Exit {
            session_id: shared.cfg.session_id.clone(),
            run_id: shared.cfg.run_id.clone(),
            run_ordinal: shared.cfg.run_ordinal,
            code,
            signal,
            group_cleaned,
            reason: exit_reason.to_string(),
        },
    );
    info!(?code, ?signal, group_cleaned, "stop flow complete");
    // Let the PTY reader observe EOF and finish() the log before we leave.
    wait_pty_eof(rx, Duration::from_secs(2));
    // Exit and final output have been enqueued. Fast clients need no artificial
    // delay; slow clients retain the existing bounded shutdown allowance.
    server::flush_clients(shared, Duration::from_millis(200));
    shutdown(shared, code, signal, group_cleaned, exit_reason);
    EXIT_OK
}

/// PRD 3.3: child exited on its own (PTY EOF/EIO) -> report, drain, exit 0.
/// Leftover background jobs (orphaned when the leader died) are cleaned up —
/// a finished session must not leave stray processes behind.
fn natural_exit(
    shared: &Arc<Shared>,
    sm: &mut StateMachine,
    status_file: &mut Option<File>,
    rx: &mpsc::Receiver<HostMsg>,
    reaper: &mut Reaper,
) -> i32 {
    let (code, signal) = reaper.reap_timeout(Duration::from_secs(3));
    // EOF normally follows a child exit, but a PTY can close independently.
    // Never let the Host report a natural completion while the process leader
    // is still alive; that would detach a real agent from its cleanup owner.
    if code.is_none() && signal.is_none() && leader_alive(shared.child_pid) {
        warn!(
            child_pid = shared.child_pid,
            "pty EOF arrived before child exit; entering controlled stop flow"
        );
        return stop_flow(
            shared,
            sm,
            status_file,
            None,
            rx,
            "pty_eof_before_exit",
            reaper,
        );
    }
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
        emit_event(shared, status_file, ev);
    }
    broadcast(
        shared,
        &HostFrame::Exit {
            session_id: shared.cfg.session_id.clone(),
            run_id: shared.cfg.run_id.clone(),
            run_ordinal: shared.cfg.run_ordinal,
            code,
            signal,
            group_cleaned,
            reason: "natural".to_string(),
        },
    );
    info!(
        ?code,
        ?signal,
        group_cleaned,
        "child exited; draining clients for 2s"
    );
    std::thread::sleep(Duration::from_secs(2));
    shutdown(shared, code, signal, group_cleaned, "natural");
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

/// Identity (dev, ino) of the bound socket file; `None` when metadata is
/// unavailable. Compared at shutdown to distinguish this Host's own binding
/// from a successor Host that rebound the same stable path.
fn socket_file_id(path: &Path) -> Option<(u64, u64)> {
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

/// Unlink the socket file only while it still names THIS Host's binding.
/// During a Session restart the successor Host rebinds the stable path while
/// this Host is still draining clients; an unconditional unlink would delete
/// the successor's directory entry and leave a live Host permanently
/// unreachable — attach/stop/archive could no longer verify it ("host is
/// unreachable; stop cannot be verified safely").
fn remove_socket_file(path: &Path, owned_id: Option<(u64, u64)>) {
    let should_remove = match (owned_id, socket_file_id(path)) {
        (Some(owned), Some(current)) => owned == current,
        // Already gone (the successor removed our stale file): nothing to do.
        (_, None) => false,
        // Identity was never captured at bind: keep the legacy cleanup
        // semantics rather than leaking the socket file.
        (None, Some(_)) => true,
    };
    if should_remove {
        let _ = std::fs::remove_file(path);
    }
}

fn shutdown(
    shared: &Shared,
    code: Option<i32>,
    signal: Option<i32>,
    group_cleaned: bool,
    exit_reason: &str,
) {
    // Publish the durable terminal fact before making the Host unreachable.
    // Otherwise an archive request can observe a live Host PID, a missing
    // socket, and no safe evidence that the Agent already exited.
    write_host_state(shared, Some((code, signal, group_cleaned, exit_reason)));
    remove_socket_file(Path::new(&shared.cfg.socket_path), shared.socket_file_id);
    info!("host shutdown complete");
}

/// `<session_dir>/host-state.json` (0600): startup facts + exit facts.
fn write_host_state(shared: &Shared, exit: Option<(Option<i32>, Option<i32>, bool, &str)>) {
    let mut v = serde_json::json!({
        "pid": shared.child_pid,
        "host_pid": std::process::id(),
        "session_id": &shared.cfg.session_id,
        "run_id": &shared.cfg.run_id,
        "run_ordinal": shared.cfg.run_ordinal,
        "socket_path": &shared.cfg.socket_path,
        "started_at": shared.started_at.to_rfc3339(),
        "pgid": shared.pgid,
        "pgid_verified": shared.pgid_verified,
    });
    if let Some((code, signal, cleaned, reason)) = exit {
        v["exit_code"] = serde_json::json!(code);
        v["signal"] = serde_json::json!(signal);
        v["group_cleaned"] = serde_json::json!(cleaned);
        v["exit_reason"] = serde_json::json!(reason);
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
        Ok(mut f) => match serde_json::to_vec_pretty(&v) {
            Ok(payload) => {
                if let Err(e) = f
                    .write_all(&payload)
                    .and_then(|_| f.flush())
                    .and_then(|_| f.sync_all())
                {
                    warn!("flush host-state.json failed: {e}");
                }
            }
            Err(e) => warn!("serialize host-state.json failed: {e}"),
        },
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

/// PTY reader thread: raw bytes -> redactor -> bounded live ring -> broadcast.
const MAX_PI_STARTUP_NOTICE_BYTES: usize = 1024;

struct PiPtyStartupNoticeFilter {
    native_session_id: String,
    pending: Vec<u8>,
    decided: bool,
}

impl PiPtyStartupNoticeFilter {
    fn new(native_session_id: String) -> Self {
        Self {
            native_session_id,
            pending: Vec::new(),
            decided: false,
        }
    }

    fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.decided {
            return chunk.to_vec();
        }
        self.pending.extend_from_slice(chunk);
        let line_end = self.pending.iter().position(|byte| *byte == b'\n');
        if line_end.is_none() && self.pending.len() <= MAX_PI_STARTUP_NOTICE_BYTES {
            return Vec::new();
        }
        self.decided = true;
        if let Some(line_end) = line_end {
            let remainder = self.pending.split_off(line_end + 1);
            let line = std::mem::take(&mut self.pending);
            if is_pi_initial_session_notice_line(&line, &self.native_session_id) {
                remainder
            } else {
                [line, remainder].concat()
            }
        } else {
            std::mem::take(&mut self.pending)
        }
    }

    fn finish(&mut self) -> Vec<u8> {
        if self.decided {
            return Vec::new();
        }
        self.decided = true;
        let pending = std::mem::take(&mut self.pending);
        if is_pi_initial_session_notice_line(&pending, &self.native_session_id) {
            Vec::new()
        } else {
            pending
        }
    }
}

fn is_pi_initial_session_notice_line(line: &[u8], native_session_id: &str) -> bool {
    let mut plain = Vec::with_capacity(line.len());
    let mut index = 0;
    while index < line.len() {
        if line[index] != 0x1b {
            plain.push(line[index]);
            index += 1;
            continue;
        }
        if line.get(index + 1) != Some(&b'[') {
            return false;
        }
        let mut end = index + 2;
        while end < line.len() && !(0x40..=0x7e).contains(&line[end]) {
            end += 1;
        }
        if line.get(end) != Some(&b'm') {
            return false;
        }
        index = end + 1;
    }
    while matches!(plain.last(), Some(b'\r' | b'\n')) {
        plain.pop();
    }
    plain == format!(
        "Warning: No project session found with id '{native_session_id}'; creating a new session with that id."
    )
    .as_bytes()
}

fn append_live_output(data: Vec<u8>, shared: &Shared) {
    let _output_guard = shared.output_serial.lock().unwrap();
    let offset = shared.output_tail.lock().unwrap().append(&data);
    let end = offset.saturating_add(data.len() as u64);
    shared.log_bytes.store(end, Ordering::Relaxed);
    *shared.log_position.lock().unwrap() = (0, end);
    broadcast(
        shared,
        &HostFrame::Output {
            session_id: shared.cfg.session_id.clone(),
            data,
            offset,
            cursor: LogCursor {
                run_id: shared.cfg.run_id.clone(),
                run_ordinal: shared.cfg.run_ordinal,
                generation: 0,
                offset: offset.min(i64::MAX as u64) as i64,
            },
        },
    );
}

fn spawn_pty_reader(
    mut reader: Box<dyn Read + Send>,
    redactor: Option<Redactor>,
    shared: Arc<Shared>,
    tx: mpsc::Sender<HostMsg>,
) {
    std::thread::spawn(move || {
        let mut detector =
            PtyDetector::with_needs_input(shared.cfg.detect_pty_needs_input, &[], &[]);
        let adapter = (shared.cfg.adapter_type == "kimi").then(|| adapter_for(AgentType::Kimi));
        let mut redactor = redactor;
        let mut pi_startup_notice_filter = (shared.cfg.adapter_type == "pi")
            .then(|| shared.cfg.agent_session_id_hint.clone())
            .flatten()
            .map(PiPtyStartupNoticeFilter::new);
        let mut buf = [0u8; 16 * 1024];
        let mut pty_fault = None;
        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    info!("pty EOF");
                    break;
                }
                Ok(n) => {
                    let chunk = &buf[..n];
                    *shared.last_output_at.lock().unwrap() = Instant::now();
                    let chunk = match &mut pi_startup_notice_filter {
                        Some(filter) => filter.feed(chunk),
                        None => chunk.to_vec(),
                    };
                    let data = match &mut redactor {
                        Some(r) => r.feed(&chunk),
                        None => chunk.clone(),
                    };
                    if !data.is_empty() {
                        append_live_output(data, &shared);
                    }
                    for obs in detector.feed(&chunk) {
                        let _ = tx.send(HostMsg::Obs(obs));
                    }
                    if let Some(adapter) = &adapter {
                        if let Some(id) = adapter.extract_session_id(&detector.stripped_tail()) {
                            set_agent_session_id(&shared, &id);
                        }
                    }
                }
                Err(e) => {
                    // EIO often follows all slave fds closing, but it is not
                    // proof that the child has exited. Preserve the distinct
                    // failure fact for the control loop so it can verify and
                    // clean up a still-live process group.
                    warn!("pty read failed: {e}");
                    pty_fault = Some(e.to_string());
                    break;
                }
            }
        }
        if let Some(filter) = &mut pi_startup_notice_filter {
            let chunk = filter.finish();
            if !chunk.is_empty() {
                let data = match &mut redactor {
                    Some(redactor) => redactor.feed(&chunk),
                    None => chunk,
                };
                if !data.is_empty() {
                    append_live_output(data, &shared);
                }
            }
        }
        // Flush the redactor's withheld tail so secrets never leak via the
        // final partial chunk.
        if let Some(r) = &mut redactor {
            let tail = r.finish();
            if !tail.is_empty() {
                append_live_output(tail, &shared);
            }
            info!(redaction_hits = r.hits(), "redactor finished");
        }
        let terminal = match pty_fault {
            Some(message) => HostMsg::PtyFault { message },
            None => HostMsg::PtyEof,
        };
        let _ = tx.send(terminal);
    });
}

const MAX_RPC_LINE_BYTES: usize = 1024 * 1024;

/// Read one LF-delimited RPC frame without ever accumulating an unbounded
/// line. Pi's protocol is JSONL, so an overlong frame is a protocol fault,
/// not text output that can be split safely.
fn read_rpc_line(
    reader: &mut BufReader<Box<dyn Read + Send>>,
    line: &mut Vec<u8>,
) -> std::io::Result<Option<()>> {
    line.clear();
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(()))
            };
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        // The trailing LF is framing, not payload. EOF has no LF, so this
        // also rejects an oversized final partial line.
        let payload_take = if available[..take].last() == Some(&b'\n') {
            take.saturating_sub(1)
        } else {
            take
        };
        if line.len().saturating_add(payload_take) > MAX_RPC_LINE_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Pi RPC line exceeds {MAX_RPC_LINE_BYTES} bytes"),
            ));
        }
        line.extend_from_slice(&available[..take]);
        let complete = available[..take].last() == Some(&b'\n');
        reader.consume(take);
        if complete {
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(()));
        }
    }
}

fn redact_rpc_value(value: &mut serde_json::Value, secrets: &[String]) {
    match value {
        serde_json::Value::String(text) => {
            for secret in secrets {
                if text.contains(secret) {
                    *text = text.replace(secret, "***");
                }
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                redact_rpc_value(value, secrets);
            }
        }
        serde_json::Value::Object(values) => {
            for value in values.values_mut() {
                redact_rpc_value(value, secrets);
            }
        }
        _ => {}
    }
}

/// Pipe-mode reader: stdout must contain only valid Pi JSONL events or
/// responses. A malformed line terminates the Session through the existing
/// controlled-stop flow; the generic diagnostic is durable in host.log while
/// the untrusted raw line is never copied into an error frame.
fn spawn_rpc_reader(
    reader: Box<dyn Read + Send>,
    secrets: Vec<String>,
    shared: Arc<Shared>,
    tx: mpsc::Sender<HostMsg>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut line = Vec::with_capacity(8 * 1024);
        let mut fault = None;
        loop {
            match read_rpc_line(&mut reader, &mut line) {
                Ok(None) => break,
                Ok(Some(())) if line.is_empty() => continue,
                Ok(Some(())) => {
                    let mut event: serde_json::Value = match serde_json::from_slice(&line) {
                        Ok(event) => event,
                        Err(error) => {
                            fault = Some(format!("Pi RPC emitted invalid JSON: {error}"));
                            break;
                        }
                    };
                    if !event.is_object() {
                        fault = Some("Pi RPC emitted a non-object JSON frame".into());
                        break;
                    }
                    // `get_state` is the proof that the native Pi ID agrees
                    // with AgentPort's assigned/resumed identity.
                    let is_successful_get_state =
                        event.get("type").and_then(serde_json::Value::as_str) == Some("response")
                            && event.get("command").and_then(serde_json::Value::as_str)
                                == Some("get_state")
                            && event.get("success").and_then(serde_json::Value::as_bool)
                                == Some(true);
                    if is_successful_get_state {
                        let native = event
                            .pointer("/data/sessionId")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned);
                        match native {
                            Some(native) if !native.is_empty() => {
                                if shared
                                    .cfg
                                    .agent_session_id_hint
                                    .as_deref()
                                    .is_some_and(|expected| expected != native)
                                {
                                    fault = Some("Pi RPC reported a session ID different from the persisted Session identity".into());
                                    break;
                                }
                                set_agent_session_id(&shared, &native);
                            }
                            _ => {
                                fault = Some("Pi RPC get_state response omitted sessionId".into());
                                break;
                            }
                        }
                    }
                    redact_rpc_value(&mut event, &secrets);
                    let mut logged = match serde_json::to_vec(&event) {
                        Ok(value) => value,
                        Err(error) => {
                            fault = Some(format!("Pi RPC event could not be serialized: {error}"));
                            break;
                        }
                    };
                    logged.push(b'\n');
                    append_live_output(logged, &shared);
                    *shared.last_output_at.lock().unwrap() = Instant::now();
                    let is_agent_settled = event.get("type").and_then(serde_json::Value::as_str)
                        == Some("agent_settled");
                    // Successful startup state is an internal identity check.
                    // Keep it durable for recovery diagnostics, but do not
                    // render its full payload as if it were a user event.
                    if !is_successful_get_state {
                        broadcast(
                            &shared,
                            &HostFrame::Structured {
                                session_id: shared.cfg.session_id.clone(),
                                event,
                            },
                        );
                    }
                    let _ = tx.send(HostMsg::Obs(Observation::PtyActivity));
                    if is_agent_settled {
                        let _ = tx.send(HostMsg::Obs(Observation::AdapterTurnEnd {
                            adapter: "pi".into(),
                        }));
                    }
                }
                Err(error) => {
                    fault = Some(format!("Pi RPC stream read failed: {error}"));
                    break;
                }
            }
        }
        let terminal = match fault {
            Some(message) => HostMsg::PtyFault { message },
            None => HostMsg::PtyEof,
        };
        let _ = tx.send(terminal);
    });
}

fn is_pi_initial_session_creation_notice(diagnostic: &str) -> bool {
    diagnostic.starts_with("Warning: No project session found with id '")
        && diagnostic.ends_with("'; creating a new session with that id.")
}

/// Pi reserves stderr for diagnostics. Keep it out of the structured event
/// schema and redact known secret strings before it reaches the private Host
/// log; JSON stdout remains the sole protocol channel.
fn spawn_rpc_stderr_reader(
    mut reader: Box<dyn Read + Send>,
    secrets: Vec<String>,
    shared: Arc<Shared>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => return,
                Ok(size) => {
                    let mut diagnostic =
                        String::from_utf8_lossy(&buffer[..size]).replace(['\n', '\r'], " ");
                    for secret in &secrets {
                        diagnostic = diagnostic.replace(secret, "***");
                    }
                    // Stderr may carry provider diagnostics. The per-session
                    // host log is 0600 and the UI receives only this redacted
                    // structured diagnostic.
                    warn!(session_id = %shared.cfg.session_id, diagnostic = %diagnostic, "Pi RPC stderr");
                    // Pi emits this exact warning when AgentPort intentionally
                    // starts a fresh private session. It is useful in host.log
                    // but is not actionable for a user in the conversation.
                    if !is_pi_initial_session_creation_notice(&diagnostic) {
                        broadcast(
                            &shared,
                            &HostFrame::Structured {
                                session_id: shared.cfg.session_id.clone(),
                                event: serde_json::json!({
                                    "type": "diagnostic",
                                    "stream": "stderr",
                                    "message": diagnostic,
                                }),
                            },
                        );
                    }
                }
                Err(error) => {
                    warn!(session_id = %shared.cfg.session_id, "Pi RPC stderr read failed: {error}");
                    return;
                }
            }
        }
    });
}

/// Hook-event poller: every 250ms consume new JSON lines from
/// `hook_events_path` ("event"/"hook_event_name"/"type" -> Hook observation;
/// nested "data.session_id" or raw "session_id" -> native session id capture).
const MAX_HOOK_SNAPSHOT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_HOOK_RECORD_BYTES: usize = 4 * 1024 * 1024;
const MAX_HOOK_RECORDS_PER_POLL: usize = 256;
const MAX_HOOK_BYTES_PER_POLL: usize = MAX_HOOK_RECORD_BYTES + 1;

struct HookSnapshot {
    offset: u64,
    inherited_turn_complete: bool,
}

impl HookSnapshot {
    fn capture(cfg: &HostConfig) -> Self {
        let path = Path::new(&cfg.hook_events_path);
        let offset = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        let inherited_turn_complete =
            cfg.agent_session_id_hint
                .as_deref()
                .is_some_and(|native_id| {
                    matches!(cfg.adapter_type.as_str(), "claude" | "qoder")
                        && latest_hook_turn_is_complete(
                            path,
                            offset,
                            &cfg.adapter_type,
                            &cfg.session_id,
                            native_id,
                        )
                });
        Self {
            offset,
            inherited_turn_complete,
        }
    }
}

fn latest_hook_turn_is_complete(
    path: &Path,
    length: u64,
    adapter: &str,
    session_id: &str,
    native_id: &str,
) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let start = length.saturating_sub(MAX_HOOK_SNAPSHOT_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }
    let mut tail = Vec::with_capacity((length - start) as usize);
    if file.read_to_end(&mut tail).is_err() {
        return false;
    }
    if start > 0 {
        let Some(first_newline) = tail.iter().position(|byte| *byte == b'\n') else {
            return false;
        };
        tail.drain(..=first_newline);
    }
    if !tail.ends_with(b"\n") {
        return false;
    }
    for line in tail.split(|byte| *byte == b'\n').rev() {
        if line.is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_slice::<serde_json::Value>(line) else {
            return false;
        };
        let name = ["event", "hook_event_name", "type"]
            .iter()
            .find_map(|key| event.get(*key))
            .and_then(|value| value.as_str());
        match name {
            Some("Stop") => {
                let belongs_to_session = match adapter {
                    "claude" => {
                        event.get("session_id").and_then(serde_json::Value::as_str)
                            == Some(session_id)
                            && event
                                .pointer("/data/session_id")
                                .and_then(serde_json::Value::as_str)
                                == Some(native_id)
                    }
                    "qoder" => {
                        event
                            .get("agentport_session_id")
                            .and_then(serde_json::Value::as_str)
                            == Some(session_id)
                    }
                    _ => false,
                };
                return belongs_to_session;
            }
            // SessionStart can belong to a cleared/rolled-over native session;
            // never inherit completion across that identity boundary.
            Some("SessionStart") => return false,
            Some("SessionEnd" | "Notification") => continue,
            Some(_) | None => return false,
        }
    }
    false
}

struct BoundedHookRecordRead {
    consumed: usize,
    complete: bool,
    oversized: bool,
}

fn read_bounded_hook_record<R: BufRead>(
    reader: &mut R,
    line: &mut Vec<u8>,
    already_oversized: bool,
    byte_budget: usize,
) -> std::io::Result<Option<BoundedHookRecordRead>> {
    line.clear();
    let mut consumed = 0usize;
    let mut oversized = already_oversized;
    while consumed < byte_budget {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            break;
        }
        let remaining_budget = byte_budget - consumed;
        let available = &available[..available.len().min(remaining_budget)];
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if !oversized {
            let remaining = MAX_HOOK_RECORD_BYTES.saturating_sub(line.len());
            let retained = take.min(remaining);
            line.extend_from_slice(&available[..retained]);
            oversized = retained < take;
        }
        let complete = available[..take].last() == Some(&b'\n');
        reader.consume(take);
        consumed = consumed.saturating_add(take);
        if complete {
            return Ok(Some(BoundedHookRecordRead {
                consumed,
                complete: true,
                oversized,
            }));
        }
    }
    Ok((consumed > 0).then_some(BoundedHookRecordRead {
        consumed,
        complete: false,
        oversized,
    }))
}

fn spawn_hook_poller(shared: Arc<Shared>, tx: mpsc::Sender<HostMsg>, initial_offset: u64) {
    let path = PathBuf::from(&shared.cfg.hook_events_path);
    std::thread::spawn(move || {
        // The snapshot was captured before child spawn. Starting here avoids
        // feeding prior-run hook events into a new run's state machine.
        let mut offset = initial_offset;
        let mut draining_oversized = false;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue, // no hooks configured / not created yet
            };
            if meta.len() < offset {
                offset = 0; // truncated: start over
                draining_oversized = false;
            }
            if meta.len() == offset {
                continue;
            }
            let observed_at = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let mut f = match File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if f.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            // Freeze this poll at the metadata boundary; later appends remain
            // for the next poll and cannot change this batch's ordering facts.
            let mut reader = BufReader::new(f).take(meta.len() - offset);
            let mut line = Vec::new();
            let mut remaining_budget = MAX_HOOK_BYTES_PER_POLL;
            for _ in 0..MAX_HOOK_RECORDS_PER_POLL {
                if remaining_budget == 0 {
                    break;
                }
                let Ok(record) = read_bounded_hook_record(
                    &mut reader,
                    &mut line,
                    draining_oversized,
                    remaining_budget,
                ) else {
                    break;
                };
                let Some(record) = record else {
                    break;
                };
                remaining_budget = remaining_budget.saturating_sub(record.consumed);
                if !record.complete {
                    if record.oversized {
                        offset = offset.saturating_add(record.consumed as u64);
                        draining_oversized = true;
                    }
                    break;
                }

                offset = offset.saturating_add(record.consumed as u64);
                draining_oversized = false;
                if record.oversized {
                    warn!(path = %path.display(), bytes = record.consumed, "hook record exceeds parse limit");
                    continue;
                }
                let v: serde_json::Value = match serde_json::from_slice(&line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let event_name = ["event", "hook_event_name", "type"]
                    .iter()
                    .find_map(|key| v.get(*key))
                    .and_then(|value| value.as_str());
                if let Some(name) = event_name {
                    let producer_observed_at = v
                        .get("observed_at_unix")
                        .and_then(serde_json::Value::as_u64)
                        .map(|seconds| SystemTime::UNIX_EPOCH + Duration::from_secs(seconds));
                    let completion_input_boundary = producer_observed_at
                        .or_else(|| (offset == meta.len()).then_some(observed_at));
                    let _ = tx.send(HostMsg::HookObs {
                        name: name.to_string(),
                        completion_input_boundary,
                    });
                }

                // A launch hint proves the initial identity, but Claude may
                // legitimately replace it after /clear or a foreground fork.
                // Only SessionStart may replace a hint; without a hint, any
                // native-bearing hook can establish the initial identity.
                let may_update_id = shared.cfg.agent_session_id_hint.is_none()
                    || event_name == Some("SessionStart");
                if may_update_id {
                    let native_id = ["/data/session_id", "/data/sessionId"]
                        .iter()
                        .find_map(|pointer| v.pointer(pointer))
                        .or_else(|| {
                            ["session_id", "sessionId"]
                                .iter()
                                .find_map(|key| v.get(*key))
                        })
                        .and_then(|value| value.as_str());
                    if let Some(id) = native_id {
                        // AgentPort's hook wrapper also has a top-level
                        // session_id. It is routing metadata, not a native ID.
                        if !id.is_empty() && id != shared.cfg.session_id {
                            set_agent_session_id(&shared, id);
                        }
                    }
                }
            }
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

#[cfg(test)]
mod idle_shutdown_tests {
    use super::*;

    #[test]
    fn becomes_due_only_after_the_full_delay() {
        let start = Instant::now();
        let mut shutdown = SemanticIdleShutdown::new(Duration::from_secs(15 * 60));
        shutdown.arm(start, 0);

        assert!(!shutdown.due(start + Duration::from_secs(15 * 60 - 1)));
        assert!(shutdown.due(start + Duration::from_secs(15 * 60)));
    }

    #[test]
    fn completed_turn_inherited_by_a_resumed_host_arms_the_full_delay() {
        let start = Instant::now();
        let mut shutdown =
            SemanticIdleShutdown::at_host_start(Duration::from_secs(15 * 60), start, 7, true);
        assert_eq!(
            shutdown.deadline(),
            Some(start + Duration::from_secs(15 * 60))
        );
        let input_at = start + Duration::from_secs(1);
        assert!(shutdown.observe_user_activity(8, input_at, false));
        assert_eq!(
            shutdown.deadline(),
            Some(input_at + Duration::from_secs(15 * 60))
        );

        let fresh =
            SemanticIdleShutdown::at_host_start(Duration::from_secs(15 * 60), start, 7, false);
        assert!(fresh.deadline().is_none());
    }

    #[test]
    fn only_supported_main_turn_completion_signals_arm_cleanup() {
        for adapter in ["pi", "kimi"] {
            assert!(is_semantic_turn_complete(
                &Observation::AdapterTurnEnd {
                    adapter: adapter.into()
                },
                adapter
            ));
        }
        for adapter in ["claude", "codex", "qoder"] {
            assert!(is_semantic_turn_complete(
                &Observation::Hook("Stop".into()),
                adapter
            ));
        }
        assert!(!is_semantic_turn_complete(
            &Observation::Hook("SubagentStop".into()),
            "claude"
        ));
        assert!(!is_semantic_turn_complete(
            &Observation::Hook("Stop".into()),
            "shell"
        ));
    }

    #[test]
    fn semantic_work_cancels_cleanup_but_idle_pty_repaints_do_not() {
        assert!(is_semantic_turn_activity(
            &Observation::Hook("PreToolUse".into()),
            "qoder"
        ));
        assert!(!is_semantic_turn_activity(
            &Observation::PtyActivity,
            "qoder"
        ));
        assert!(!is_semantic_turn_activity(
            &Observation::PtySilence { ms: 60_000 },
            "qoder"
        ));

        let start = Instant::now();
        let mut shutdown = SemanticIdleShutdown::new(Duration::from_secs(15 * 60));
        shutdown.arm(start, 0);
        assert!(shutdown.cancel());
        assert!(!shutdown.due(start + Duration::from_secs(60 * 60)));
    }

    #[test]
    fn hook_snapshot_inherits_only_a_completed_exact_claude_or_qoder_turn() {
        const SESSION_ID: &str = "ses_exact";
        const NATIVE_ID: &str = "3322eb77-e4d5-421c-92a1-aff429b700cf";
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        std::fs::write(
            &path,
            format!(
                "{{\"event\":\"Stop\",\"agentport_session_id\":\"{SESSION_ID}\"}}\n{{\"event\":\"SessionEnd\"}}\n"
            ),
        )
        .unwrap();
        let length = std::fs::metadata(&path).unwrap().len();
        assert!(latest_hook_turn_is_complete(
            &path, length, "qoder", SESSION_ID, NATIVE_ID
        ));
        assert!(!latest_hook_turn_is_complete(
            &path,
            length,
            "qoder",
            "ses_other",
            NATIVE_ID
        ));

        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"{\"event\":\"SessionStart\"}\n").unwrap();
        file.flush().unwrap();
        let length = std::fs::metadata(&path).unwrap().len();
        assert!(!latest_hook_turn_is_complete(
            &path, length, "qoder", SESSION_ID, NATIVE_ID
        ));

        std::fs::write(
            &path,
            format!(
                "{{\"event\":\"Stop\",\"session_id\":\"{SESSION_ID}\",\"data\":{{\"session_id\":\"{NATIVE_ID}\"}}}}\n"
            ),
        )
        .unwrap();
        let length = std::fs::metadata(&path).unwrap().len();
        assert!(latest_hook_turn_is_complete(
            &path, length, "claude", SESSION_ID, NATIVE_ID
        ));
        assert!(!latest_hook_turn_is_complete(
            &path,
            length,
            "claude",
            SESSION_ID,
            "755bfca0-6dac-48ac-9bf9-1b3ccc46acfc"
        ));

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"{\"event\":\"UserPromptSubmit\"}\n")
            .unwrap();
        file.flush().unwrap();
        let length = std::fs::metadata(&path).unwrap().len();
        assert!(!latest_hook_turn_is_complete(
            &path, length, "claude", SESSION_ID, NATIVE_ID
        ));
    }

    #[test]
    fn user_input_postpones_the_completed_turn_deadline() {
        assert!(!input_requires_turn_fence("pi", AgentTransport::Pty));
        assert!(!input_requires_turn_fence("kimi", AgentTransport::Pty));
        assert!(input_requires_turn_fence("claude", AgentTransport::Pty));
        assert!(input_requires_turn_fence("codex", AgentTransport::Pty));
        assert!(input_requires_turn_fence("qoder", AgentTransport::Pty));
        assert!(input_requires_turn_fence("pi", AgentTransport::JsonRpc));

        let start = Instant::now();
        let input_at = start + Duration::from_secs(14 * 60);
        let mut shutdown = SemanticIdleShutdown::new(Duration::from_secs(15 * 60));
        shutdown.arm(start, 7);
        assert!(!shutdown.observe_user_activity(7, input_at, false));
        assert!(shutdown.observe_user_activity(8, input_at, false));

        assert_eq!(
            shutdown.deadline(),
            Some(input_at + Duration::from_secs(15 * 60))
        );
        assert!(!shutdown.due(input_at + Duration::from_secs(15 * 60 - 1)));
        assert!(shutdown.due(input_at + Duration::from_secs(15 * 60)));

        let mut no_live_turn_start = SemanticIdleShutdown::new(Duration::from_secs(15 * 60));
        no_live_turn_start.arm(start, 7);
        assert!(no_live_turn_start.observe_user_activity(8, input_at, true));
        assert!(no_live_turn_start.deadline().is_none());
    }

    #[test]
    fn completed_semantic_turn_uses_the_reduced_descendant_refresh_cadence() {
        assert!(descendant_refresh_due(0, false));
        assert!(descendant_refresh_due(3, false));
        assert!(!descendant_refresh_due(1, false));

        assert!(descendant_refresh_due(0, true));
        assert!(descendant_refresh_due(60, true));
        assert!(!descendant_refresh_due(3, true));
    }
}

#[cfg(test)]
mod pi_pty_startup_notice_tests {
    use super::*;

    #[test]
    fn filters_the_exact_notice_across_pty_frames() {
        let id = "pi-native-test-id";
        let notice = format!(
            "\x1b[33mWarning: No project session found with id '{id}'; creating a new session with that id.\x1b[39m\r\n"
        );
        let mut filter = PiPtyStartupNoticeFilter::new(id.into());
        assert!(filter.feed(&notice.as_bytes()[..31]).is_empty());
        let mut second = notice.as_bytes()[31..].to_vec();
        second.extend_from_slice(b"Pi TUI ready\r\n");
        assert_eq!(filter.feed(&second), b"Pi TUI ready\r\n");
        assert!(filter.finish().is_empty());
    }

    #[test]
    fn keeps_a_different_startup_diagnostic() {
        let mut filter = PiPtyStartupNoticeFilter::new("pi-native-test-id".into());
        let diagnostic = b"Warning: provider authentication failed\r\n";
        assert_eq!(filter.feed(diagnostic), diagnostic);
    }
}

#[cfg(test)]
mod socket_cleanup_tests {
    use super::*;

    #[test]
    fn remove_socket_file_unlinks_own_binding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.sock");
        std::fs::write(&path, b"a").unwrap();
        let owned = socket_file_id(&path);
        remove_socket_file(&path, owned);
        assert!(!path.exists());
    }

    #[test]
    fn remove_socket_file_preserves_rebound_successor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.sock");
        std::fs::write(&path, b"a").unwrap();
        let owned = socket_file_id(&path);
        // Successor rebinds the stable path: remove + recreate yields a new
        // file identity that must not be touched by the old owner's cleanup.
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, b"b").unwrap();
        remove_socket_file(&path, owned);
        assert_eq!(std::fs::read(&path).unwrap(), b"b");
    }

    #[test]
    fn remove_socket_file_tolerates_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.sock");
        // Must not panic and must not create anything.
        remove_socket_file(&path, Some((1, 2)));
        remove_socket_file(&path, None);
        assert!(!path.exists());
    }
}
