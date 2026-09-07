//! Unix socket server (PRD 3.3/3.6): one accept thread, one thread per
//! connection doing handshake -> optional tail replay -> frame loop, plus one
//! writer thread per registered client draining its broadcast channel.
//!
//! Handshake: within 5s the first frame MUST be `ClientFrame::Hello` with
//! protocol == PROTOCOL_VERSION and matching session id + token; anything
//! else gets a generic `Error` and the connection is closed (no detail about
//! which part failed — the token's correctness is never leaked).

use std::io::{BufReader, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use agentport_core::models::{AgentTransport, LogCursor};
use agentport_core::protocol::{
    encode_frame, read_frame, write_frame, ClientFrame, HostFrame, InputBatchAckPhase,
    TerminalGeometry, HOST_FEATURE_INPUT_BATCH_V1, HOST_FEATURE_TERMINAL_GEOMETRY_V1,
    HOST_FEATURE_TERMINAL_SEED_V1, PROTOCOL_VERSION,
};
use chrono::Utc;
use nix::sys::signal::Signal;
use portable_pty::PtySize;
use tracing::{info, warn};

use crate::{
    current_log_cursor, err_frame, note_user_activity, signal_group, status_frame, HostErrorCode,
    HostMsg, Shared,
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const REPLAY_CHUNK: usize = 64 * 1024;
const MAX_REPLAY_BYTES: u64 = 4 * 1024 * 1024;
/// Bound authenticated GUI connections per Host so stale GUI processes cannot
/// consume an unbounded number of socket and writer-thread resources.
pub(crate) const MAX_AUTHENTICATED_CLIENTS: usize = 16;
/// A PTY read produces at most 16 KiB per Output frame, so this caps the
/// common output backlog at roughly 2 MiB per client without blocking PTY.
const CLIENT_OUTBOUND_QUEUE_CAPACITY: usize = 128;
/// A writer runs on its own thread, but a timeout prevents a non-reading peer
/// from retaining that thread forever when its kernel socket buffer is full.
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const CLIENT_WRITER_POLL: Duration = Duration::from_millis(100);
/// A single batch is intentionally smaller than the outer socket framing
/// ceiling so one remote paste cannot monopolize the Host input executor.
const MAX_INPUT_BATCH_BYTES: usize = 256 * 1024;
pub(crate) const INPUT_QUEUE_CAPACITY: usize = 128;

/// Metadata needed for a directed batch acknowledgement. No input bytes are
/// retained here or in the Host's logs.
struct InputAckTarget {
    client_id: u64,
    batch_id: String,
    tx: mpsc::SyncSender<OutboundFrame>,
}

/// One atomic write owned by the Host-wide input executor. All authenticated
/// socket readers, including legacy clients, use this queue.
pub(crate) struct InputMutation {
    server_sequence: u64,
    data: Vec<u8>,
    ack: Option<InputAckTarget>,
}

/// Encoded output or a queue-local writer barrier; neither changes the wire protocol.
pub(crate) enum OutboundFrame {
    Data(Arc<Vec<u8>>),
    // A queue-local barrier: acknowledged only after all earlier socket writes.
    Flush(mpsc::Sender<()>),
}

/// One entry in the Host broadcast table. The sender is bounded; an explicit
/// eviction closes the socket so the reader and writer threads for that one
/// client both wake and exit. Ordinary removal lets already-enqueued terminal
/// replies drain in order before the channel closes.
pub(crate) struct ClientSink {
    pub(crate) tx: mpsc::SyncSender<OutboundFrame>,
    pub(crate) subscribe_output: bool,
    close_stream: UnixStream,
    closed: Arc<AtomicBool>,
}

impl ClientSink {
    pub(crate) fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.close_stream.shutdown(Shutdown::Both);
    }
}

/// Tracks a connection after authentication through writer termination,
/// including tail replay. This reservation makes the per-Host limit race-free
/// without holding the clients table lock across socket I/O.
struct ClientSlot {
    shared: Arc<Shared>,
}

impl Drop for ClientSlot {
    fn drop(&mut self) {
        self.shared
            .authenticated_client_count
            .fetch_sub(1, Ordering::AcqRel);
    }
}

fn reserve_client_slot(shared: Arc<Shared>) -> Option<ClientSlot> {
    let mut count = shared.authenticated_client_count.load(Ordering::Acquire);
    loop {
        if count >= MAX_AUTHENTICATED_CLIENTS {
            return None;
        }
        match shared.authenticated_client_count.compare_exchange_weak(
            count,
            count + 1,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => return Some(ClientSlot { shared }),
            Err(actual) => count = actual,
        }
    }
}

pub(crate) fn spawn_accept_loop(
    listener: UnixListener,
    shared: Arc<Shared>,
    tx: mpsc::Sender<HostMsg>,
) {
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            match conn {
                Ok(stream) => {
                    let shared = shared.clone();
                    let tx = tx.clone();
                    std::thread::spawn(move || handle_connection(stream, shared, tx));
                }
                Err(e) => warn!("accept failed: {e}"),
            }
        }
    });
}

fn handle_connection(stream: UnixStream, shared: Arc<Shared>, tx: mpsc::Sender<HostMsg>) {
    if stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT)).is_err() {
        return;
    }
    if let Err(e) = stream.set_write_timeout(Some(CLIENT_WRITE_TIMEOUT)) {
        // This is not available on every Unix socket implementation. The
        // bounded queue still isolates the PTY producer in that case.
        warn!(error = %e, "could not set client socket write timeout");
    }
    let read_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(read_stream);

    let hello = match read_frame::<ClientFrame>(&mut reader) {
        Ok(Some(ClientFrame::Hello {
            protocol,
            session_id,
            token,
            replay_tail_bytes,
            resume_from,
            replay_target,
            subscribe_output,
        })) => (
            protocol,
            session_id,
            token,
            replay_tail_bytes,
            resume_from,
            replay_target,
            subscribe_output,
        ),
        Ok(Some(_)) => {
            // Any other first frame is a protocol violation.
            reject(&stream);
            return;
        }
        Ok(None) | Err(_) => return, // EOF / timeout / garbage: close silently
    };
    let (
        protocol,
        session_id,
        token,
        replay_tail_bytes,
        resume_from,
        replay_target,
        subscribe_output,
    ) = hello;
    if protocol != PROTOCOL_VERSION
        || session_id != shared.cfg.session_id
        || token != shared.cfg.host_token
    {
        reject(&stream);
        return;
    }
    let client_slot = match reserve_client_slot(shared.clone()) {
        Some(slot) => slot,
        None => {
            reject(&stream);
            return;
        }
    };
    let _ = stream.set_read_timeout(None);

    // Create the bounded writer queue before touching output state. Replay and
    // every later live frame use this single queue/socket writer.
    let id = shared.next_client_id.fetch_add(1, Ordering::Relaxed);
    let write_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let close_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let (frame_tx, frame_rx) = mpsc::sync_channel::<OutboundFrame>(CLIENT_OUTBOUND_QUEUE_CAPACITY);
    let closed = Arc::new(AtomicBool::new(false));

    // The PTY producer holds this same lock across append + position update +
    // broadcast. Capturing HWM, queuing replay through that point, and only
    // then registering the client therefore leaves no replay/live gap.
    {
        let _output_guard = shared.output_serial.lock().unwrap();
        let high_water = current_log_cursor(&shared);
        let mut initial_frames = vec![HostFrame::HelloOk {
            protocol: PROTOCOL_VERSION,
            session_id: shared.cfg.session_id.clone(),
            host_pid: std::process::id(),
            child_alive: shared.child_alive.load(Ordering::Relaxed),
            log_bytes: shared.log_bytes.load(Ordering::Relaxed),
            agent_session_id: shared.agent_session_id.lock().unwrap().clone(),
            run_id: shared.cfg.run_id.clone(),
            run_ordinal: shared.cfg.run_ordinal,
            current_status: shared.current_status.lock().unwrap().clone(),
            log_cursor: high_water.clone(),
            features: vec![
                HOST_FEATURE_INPUT_BATCH_V1.to_string(),
                HOST_FEATURE_TERMINAL_GEOMETRY_V1.to_string(),
                HOST_FEATURE_TERMINAL_SEED_V1.to_string(),
            ],
            terminal_geometry: Some(shared.terminal_geometry.lock().unwrap().clone()),
        }];
        if shared.process_suspended.load(Ordering::Acquire) {
            initial_frames.push(HostFrame::ProcessStatus {
                session_id: shared.cfg.session_id.clone(),
                suspended: true,
                signal: None,
            });
        }
        if subscribe_output
            && resume_from.is_none()
            && replay_target.is_none()
            && replay_tail_bytes > 0
        {
            let seed = shared.output_tail.lock().unwrap().terminal_seed.bytes();
            if !seed.is_empty() {
                initial_frames.push(HostFrame::TransientOutput {
                    session_id: shared.cfg.session_id.clone(),
                    data: seed,
                });
            }
        }
        if subscribe_output
            && (resume_from.is_some() || replay_target.is_some() || replay_tail_bytes > 0)
        {
            initial_frames.extend(build_replay_frames(
                &shared,
                resume_from.as_ref(),
                replay_target.as_ref(),
                replay_tail_bytes,
                &high_water,
            ));
        }
        if initial_frames.len() > CLIENT_OUTBOUND_QUEUE_CAPACITY {
            warn!(
                client_id = id,
                "rejecting replay that exceeds outbound queue"
            );
            reject(&stream);
            return;
        }
        for frame in initial_frames {
            let Ok(encoded) = encode_frame(&frame) else {
                return;
            };
            if frame_tx
                .try_send(OutboundFrame::Data(Arc::new(encoded)))
                .is_err()
            {
                return;
            }
        }
        shared.clients.lock().unwrap().insert(
            id,
            ClientSink {
                tx: frame_tx.clone(),
                subscribe_output,
                close_stream,
                closed: closed.clone(),
            },
        );
    }
    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            client_writer(write_stream, frame_rx, shared, id, closed, client_slot)
        });
    }
    info!(client_id = id, "client attached");

    loop {
        let frame = match read_frame::<ClientFrame>(&mut reader) {
            Ok(Some(f)) => f,
            Ok(None) => break, // client went away (GUI crash etc.) — host unaffected
            Err(_) => break,
        };
        // Every frame re-validates the session id (PRD ch.6 identity rule).
        if frame_session_id(&frame) != shared.cfg.session_id {
            let _ = queue_client_frame(
                &shared,
                id,
                &frame_tx,
                err_frame(
                    None,
                    HostErrorCode::SessionIdMismatch,
                    "session id mismatch",
                ),
            );
            break;
        }
        match frame {
            ClientFrame::Input { data, .. } => {
                if shared.cfg.transport != AgentTransport::Pty {
                    let _ = queue_client_frame(
                        &shared,
                        id,
                        &frame_tx,
                        err_frame(
                            Some(&shared.cfg.session_id),
                            HostErrorCode::TerminalInputUnavailable,
                            "terminal input is unavailable for structured sessions",
                        ),
                    );
                    continue;
                }
                // Legacy clients receive no new frame type, but their bytes
                // still share the exact same FIFO as batch-aware clients.
                if data.is_empty()
                    || data.len() > MAX_INPUT_BATCH_BYTES
                    || !enqueue_input(&shared, data, None)
                {
                    let _ = queue_client_frame(
                        &shared,
                        id,
                        &frame_tx,
                        err_frame(
                            Some(&shared.cfg.session_id),
                            HostErrorCode::TerminalInputUnavailable,
                            "terminal input was not accepted",
                        ),
                    );
                }
            }
            ClientFrame::InputBatch { batch_id, data, .. } => {
                let invalid = shared.cfg.transport != AgentTransport::Pty
                    || batch_id.is_empty()
                    || batch_id.len() > 128
                    || data.is_empty()
                    || data.len() > MAX_INPUT_BATCH_BYTES;
                let ack = InputAckTarget {
                    client_id: id,
                    batch_id,
                    tx: frame_tx.clone(),
                };
                if invalid {
                    let sequence = next_input_sequence(&shared);
                    send_input_ack(
                        &shared,
                        &ack,
                        sequence,
                        InputBatchAckPhase::NotExecuted,
                        Some("input batch validation failed"),
                    );
                    continue;
                }
                let _ = enqueue_input(&shared, data, Some(ack));
            }
            ClientFrame::StructuredPrompt { text, .. } => {
                if shared.cfg.transport != AgentTransport::JsonRpc {
                    let _ = queue_client_frame(
                        &shared,
                        id,
                        &frame_tx,
                        err_frame(
                            Some(&shared.cfg.session_id),
                            HostErrorCode::StructuredPromptTransportRequired,
                            "structured prompts require json_rpc transport",
                        ),
                    );
                    continue;
                }
                if text.trim().is_empty() {
                    let _ = queue_client_frame(
                        &shared,
                        id,
                        &frame_tx,
                        err_frame(
                            Some(&shared.cfg.session_id),
                            HostErrorCode::StructuredPromptEmpty,
                            "structured prompt must not be empty",
                        ),
                    );
                    continue;
                }
                if write_json_command(
                    &shared,
                    serde_json::json!({"type": "prompt", "message": text}),
                )
                .is_err()
                {
                    break;
                }
                note_user_activity(&shared);
            }
            ClientFrame::AbortStructuredTurn { .. } => {
                if shared.cfg.transport != AgentTransport::JsonRpc {
                    let _ = queue_client_frame(
                        &shared,
                        id,
                        &frame_tx,
                        err_frame(
                            Some(&shared.cfg.session_id),
                            HostErrorCode::StructuredAbortTransportRequired,
                            "structured abort requires json_rpc transport",
                        ),
                    );
                    continue;
                }
                if write_json_command(&shared, serde_json::json!({"type": "abort"})).is_err() {
                    break;
                }
                note_user_activity(&shared);
            }
            ClientFrame::Resize {
                cols,
                rows,
                pixel_width,
                pixel_height,
                expected_revision,
                source_kind,
                source_device_id,
                attachment_id,
                orientation,
                ..
            } => {
                let (accepted, geometry, reason, changed) = apply_terminal_resize(
                    &shared,
                    cols,
                    rows,
                    pixel_width,
                    pixel_height,
                    expected_revision,
                    source_kind,
                    source_device_id,
                    attachment_id,
                    orientation,
                );
                if !queue_client_frame(
                    &shared,
                    id,
                    &frame_tx,
                    HostFrame::ResizeAck {
                        session_id: shared.cfg.session_id.clone(),
                        accepted,
                        geometry: geometry.clone(),
                        reason,
                    },
                ) {
                    break;
                }
                if changed {
                    crate::broadcast(
                        &shared,
                        &HostFrame::TerminalGeometryChanged {
                            session_id: shared.cfg.session_id.clone(),
                            geometry,
                        },
                    );
                }
            }
            ClientFrame::Interrupt { .. } => {
                note_user_activity(&shared);
                let _ = signal_group(&shared, Signal::SIGINT);
            }
            ClientFrame::Continue { .. } => {
                note_user_activity(&shared);
                let _ = signal_group(&shared, Signal::SIGCONT);
            }
            ClientFrame::Stop { grace_ms, .. } => {
                let _ = tx.send(HostMsg::Stop { grace_ms });
            }
            ClientFrame::Ping { .. } => {
                if !queue_client_frame(
                    &shared,
                    id,
                    &frame_tx,
                    HostFrame::Pong {
                        session_id: shared.cfg.session_id.clone(),
                        at: Utc::now(),
                    },
                ) {
                    break;
                }
            }
            ClientFrame::StatusRequest { .. } => {
                let cur = shared.current_status.lock().unwrap().clone();
                if let Some(ev) = cur {
                    if !queue_client_frame(&shared, id, &frame_tx, status_frame(&ev)) {
                        break;
                    }
                }
            }
            ClientFrame::Detach { .. } => {
                // Deterministic close: drop from the broadcast table first so no
                // further heartbeats race in, then shut the socket down so the
                // client sees EOF immediately (GUI detach path, PRD 3.3).
                remove_client(&shared, id);
                let _ = stream.shutdown(std::net::Shutdown::Both);
                break;
            }
            ClientFrame::Hello { .. } => {
                let _ = queue_client_frame(
                    &shared,
                    id,
                    &frame_tx,
                    err_frame(None, HostErrorCode::DuplicateHello, "duplicate hello"),
                );
                break;
            }
        }
    }
    remove_client(&shared, id);
    info!(client_id = id, "client detached");
}

#[allow(clippy::too_many_arguments)]
fn apply_terminal_resize(
    shared: &Shared,
    cols: u16,
    rows: u16,
    pixel_width: u16,
    pixel_height: u16,
    expected_revision: Option<u64>,
    source_kind: Option<String>,
    source_device_id: Option<String>,
    attachment_id: Option<String>,
    orientation: Option<String>,
) -> (bool, TerminalGeometry, Option<String>, bool) {
    let mut current = shared.terminal_geometry.lock().unwrap();
    let reject = |reason: &str, geometry: &TerminalGeometry| {
        (false, geometry.clone(), Some(reason.to_string()), false)
    };
    if cols == 0 || rows == 0 {
        return reject("invalid_dimensions", &current);
    }

    let legacy_context = source_kind.is_none() && expected_revision.is_none();
    let (source_kind, expected_revision) = match (source_kind, expected_revision) {
        (Some(source), Some(revision)) if attachment_id.is_some() => (source, revision),
        (None, None) if current.source_kind != "mobile" => {
            ("desktop".to_string(), current.revision)
        }
        (None, None) => return reject("mobile_owner_requires_explicit_restore", &current),
        _ => return reject("incomplete_geometry_context", &current),
    };
    if !matches!(source_kind.as_str(), "mobile" | "desktop") {
        return reject("invalid_source_kind", &current);
    }
    if !legacy_context
        && (attachment_id.as_deref().map_or(true, str::is_empty)
            || (source_kind == "mobile"
                && (source_device_id.as_deref().map_or(true, str::is_empty)
                    || !matches!(orientation.as_deref(), Some("portrait" | "landscape")))))
    {
        return reject("invalid_source_context", &current);
    }
    if expected_revision != current.revision {
        return reject("stale_revision", &current);
    }
    let unchanged = current.cols == cols
        && current.rows == rows
        && current.source_kind == source_kind
        && current.source_device_id == source_device_id
        && current.attachment_id == attachment_id
        && current.orientation == orientation;
    if unchanged {
        return (true, current.clone(), None, false);
    }

    let resize_result = shared
        .master
        .lock()
        .unwrap()
        .as_mut()
        .ok_or("resize_not_supported")
        .and_then(|master| {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width,
                    pixel_height,
                })
                .map_err(|_| "resize_failed")
        });
    if let Err(reason) = resize_result {
        return reject(reason, &current);
    }

    current.cols = cols;
    current.rows = rows;
    current.source_kind = source_kind;
    current.source_device_id = source_device_id;
    current.attachment_id = attachment_id;
    current.orientation = orientation;
    current.revision = current.revision.saturating_add(1);
    current.updated_at = Utc::now();
    (true, current.clone(), None, true)
}

/// Queue a client-specific reply without ever blocking the connection reader.
/// If this client cannot keep up, evict only it and shut down its socket.
fn queue_client_frame(
    shared: &Shared,
    id: u64,
    tx: &mpsc::SyncSender<OutboundFrame>,
    frame: HostFrame,
) -> bool {
    let encoded = match encode_frame(&frame) {
        Ok(encoded) => Arc::new(encoded),
        Err(error) => {
            warn!(client_id = id, %error, "could not encode client frame");
            disconnect_client(shared, id);
            return false;
        }
    };
    match tx.try_send(OutboundFrame::Data(encoded)) {
        Ok(()) => true,
        Err(mpsc::TrySendError::Full(_)) => {
            warn!(client_id = id, "dropping client: outbound queue full");
            disconnect_client(shared, id);
            false
        }
        Err(mpsc::TrySendError::Disconnected(_)) => {
            disconnect_client(shared, id);
            false
        }
    }
}

fn remove_client(shared: &Shared, id: u64) {
    let client = shared.clients.lock().unwrap().remove(&id);
    drop(client);
}

fn disconnect_client(shared: &Shared, id: u64) {
    let client = shared.clients.lock().unwrap().remove(&id);
    if let Some(client) = client {
        client.close();
    }
}

/// One generic rejection — never reveal which credential part failed.
fn reject(stream: &UnixStream) {
    let _ = write_frame(
        &mut &*stream,
        &err_frame(None, HostErrorCode::HandshakeRejected, "handshake rejected"),
    );
}

fn frame_session_id(f: &ClientFrame) -> &str {
    match f {
        ClientFrame::Hello { session_id, .. }
        | ClientFrame::Input { session_id, .. }
        | ClientFrame::InputBatch { session_id, .. }
        | ClientFrame::StructuredPrompt { session_id, .. }
        | ClientFrame::AbortStructuredTurn { session_id }
        | ClientFrame::Resize { session_id, .. }
        | ClientFrame::Interrupt { session_id }
        | ClientFrame::Continue { session_id }
        | ClientFrame::Stop { session_id, .. }
        | ClientFrame::StatusRequest { session_id }
        | ClientFrame::Ping { session_id }
        | ClientFrame::Detach { session_id } => session_id,
    }
}

fn next_input_sequence(shared: &Shared) -> u64 {
    shared.next_input_sequence.fetch_add(1, Ordering::Relaxed)
}

/// Admit input under one mutex so the assigned sequence is the Host's sole
/// definition of receive order across independent Unix socket reader threads.
fn enqueue_input(shared: &Shared, data: Vec<u8>, ack: Option<InputAckTarget>) -> bool {
    let _admission = shared.input_admission.lock().unwrap();
    let sequence = next_input_sequence(shared);
    if shared.input_failed.load(Ordering::Acquire) {
        if let Some(ack) = ack.as_ref() {
            send_input_ack(
                shared,
                ack,
                sequence,
                InputBatchAckPhase::NotExecuted,
                Some("input executor is unavailable"),
            );
        }
        return false;
    }
    let mutation = InputMutation {
        server_sequence: sequence,
        data,
        ack,
    };
    match shared.input_queue.try_send(mutation) {
        Ok(()) => true,
        Err(mpsc::TrySendError::Full(mutation)) => {
            if let Some(ack) = mutation.ack.as_ref() {
                send_input_ack(
                    shared,
                    ack,
                    sequence,
                    InputBatchAckPhase::NotExecuted,
                    Some("input queue is full"),
                );
            }
            false
        }
        Err(mpsc::TrySendError::Disconnected(mutation)) => {
            shared.input_failed.store(true, Ordering::Release);
            if let Some(ack) = mutation.ack.as_ref() {
                send_input_ack(
                    shared,
                    ack,
                    sequence,
                    InputBatchAckPhase::NotExecuted,
                    Some("input executor is unavailable"),
                );
            }
            false
        }
    }
}

fn send_input_ack(
    shared: &Shared,
    target: &InputAckTarget,
    server_sequence: u64,
    phase: InputBatchAckPhase,
    message: Option<&str>,
) {
    let _ = queue_client_frame(
        shared,
        target.client_id,
        &target.tx,
        HostFrame::InputBatchAck {
            session_id: shared.cfg.session_id.clone(),
            batch_id: target.batch_id.clone(),
            server_sequence,
            phase,
            message: message.map(str::to_string),
        },
    );
}

/// Start the one owner of terminal writes. It emits `accepted` before touching
/// the PTY and `completed` only after a full write+flush. A write error is
/// conservatively `unknown` because `Write::write_all` may have made partial
/// progress; the run then fails closed and every queued/future batch is known
/// not to execute.
pub(crate) fn spawn_input_worker(shared: Arc<Shared>, rx: mpsc::Receiver<InputMutation>) {
    std::thread::spawn(move || {
        while let Ok(mutation) = rx.recv() {
            if shared.input_failed.load(Ordering::Acquire) {
                if let Some(ack) = mutation.ack.as_ref() {
                    send_input_ack(
                        &shared,
                        ack,
                        mutation.server_sequence,
                        InputBatchAckPhase::NotExecuted,
                        Some("input executor is unavailable"),
                    );
                }
                continue;
            }
            if let Some(ack) = mutation.ack.as_ref() {
                send_input_ack(
                    &shared,
                    ack,
                    mutation.server_sequence,
                    InputBatchAckPhase::Accepted,
                    None,
                );
            }

            // xterm delivers Ctrl-Z as a byte. The direct Agent process group
            // is orphaned from a job-control shell, so SIGSTOP supplies the
            // visible suspension and remains ordered with surrounding input.
            if mutation.data.as_slice() == [0x1a] {
                let delivered = signal_group(&shared, Signal::SIGSTOP);
                if delivered {
                    note_user_activity(&shared);
                }
                if let Some(ack) = mutation.ack.as_ref() {
                    send_input_ack(
                        &shared,
                        ack,
                        mutation.server_sequence,
                        if delivered {
                            InputBatchAckPhase::Completed
                        } else {
                            InputBatchAckPhase::NotExecuted
                        },
                        (!delivered).then_some("agent process group is unavailable"),
                    );
                }
                continue;
            }

            let result = {
                let mut writer = shared.input_writer.lock().unwrap();
                writer
                    .write_all(&mutation.data)
                    .and_then(|_| writer.flush())
            };
            match result {
                Ok(()) => {
                    note_user_activity(&shared);
                    if let Some(ack) = mutation.ack.as_ref() {
                        send_input_ack(
                            &shared,
                            ack,
                            mutation.server_sequence,
                            InputBatchAckPhase::Completed,
                            None,
                        );
                    }
                }
                Err(error) => {
                    shared.input_failed.store(true, Ordering::Release);
                    warn!(%error, "terminal input writer failed; disabling input for this run");
                    if let Some(ack) = mutation.ack.as_ref() {
                        send_input_ack(
                            &shared,
                            ack,
                            mutation.server_sequence,
                            InputBatchAckPhase::Unknown,
                            Some("terminal input completion is unknown"),
                        );
                    }
                }
            }
        }
    });
}

/// One JSON command per line is the only data written to a structured Pi
/// child. `serde_json` keeps prompt content out of a shell and preserves UTF-8
/// quoting exactly.
pub(crate) fn write_json_command(
    shared: &Shared,
    command: serde_json::Value,
) -> std::io::Result<()> {
    let mut writer = shared.input_writer.lock().unwrap();
    serde_json::to_writer(&mut *writer, &command).map_err(std::io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// Build replay frames while `Shared::output_serial` is held. Exact resume is
/// allowed only within the retained current generation and the bounded writer
/// queue. Any other cursor explicitly resets the consumer to a bounded tail.
fn build_replay_frames(
    shared: &Shared,
    resume_from: Option<&LogCursor>,
    replay_target: Option<&LogCursor>,
    tail_bytes: u64,
    high_water: &LogCursor,
) -> Vec<HostFrame> {
    let tail = shared.output_tail.lock().unwrap();
    let current_offset = tail.retained_end();
    let retained_start = tail.retained_start();
    let bounded_tail = tail_bytes.min(MAX_REPLAY_BYTES);
    let tail_start = current_offset
        .saturating_sub(bounded_tail)
        .max(retained_start);
    let mut resync_reason = None::<String>;

    let mut end = current_offset;
    let mut start = match replay_target.or(resume_from) {
        None => tail_start,
        Some(cursor)
            if cursor.run_id != high_water.run_id
                || cursor.run_ordinal != high_water.run_ordinal =>
        {
            resync_reason = Some("cursor belongs to a different run".into());
            tail_start
        }
        Some(cursor) if cursor.generation != high_water.generation => {
            resync_reason = Some("cursor generation is no longer retained".into());
            tail_start
        }
        Some(cursor)
            if cursor.offset < 0
                || cursor.offset > high_water.offset
                || (cursor.offset as u64) < retained_start =>
        {
            resync_reason = Some("cursor offset is outside the retained live tail".into());
            tail_start
        }
        Some(cursor)
            if replay_target.is_none()
                && (high_water.offset - cursor.offset) as u64 > MAX_REPLAY_BYTES =>
        {
            resync_reason = Some("requested replay exceeds the bounded writer queue".into());
            tail_start
        }
        Some(cursor) if replay_target.is_some() => {
            // A timeline target is an explicit request for nearby context,
            // not an unbounded resume to today's high-water. Keep both sides
            // bounded so a very old but retained event remains usable.
            const BEFORE: u64 = 128 * 1024;
            const AFTER: u64 = 256 * 1024;
            let target = cursor.offset as u64;
            end = current_offset.min(target.saturating_add(AFTER));
            target.saturating_sub(BEFORE).max(retained_start)
        }
        Some(cursor) => cursor.offset as u64,
    };

    let mut chunks = match tail.range_chunks(start, end, REPLAY_CHUNK) {
        Some(chunks) => chunks,
        None => {
            if (resume_from.is_some() || replay_target.is_some()) && resync_reason.is_none() {
                resync_reason = Some("requested live range is no longer retained".into());
                start = tail_start;
                end = current_offset;
                tail.range_chunks(start, end, REPLAY_CHUNK)
                    .unwrap_or_default()
            } else {
                Vec::new()
            }
        }
    };
    let queued_bytes: usize = chunks.iter().map(Vec::len).sum();
    // A failed tail read must never claim offsets for bytes that were not
    // queued. Reset the tail to an empty snapshot at the captured high-water.
    if queued_bytes as u64 != end.saturating_sub(start) {
        chunks.clear();
        start = end;
        resync_reason.get_or_insert_with(|| "retained live tail changed during replay".into());
    }

    let mut frames = Vec::with_capacity(2 + chunks.len() + usize::from(resync_reason.is_some()));
    let partial_context = replay_target.is_some() && resync_reason.is_none();
    if let Some(reason) = resync_reason {
        let mut earliest = high_water.clone();
        earliest.offset = retained_start.min(i64::MAX as u64) as i64;
        frames.push(HostFrame::ResyncRequired {
            session_id: shared.cfg.session_id.clone(),
            earliest,
            reason,
        });
    }
    let mut offset = start;
    for chunk in chunks {
        let mut cursor = high_water.clone();
        cursor.offset = offset as i64;
        offset = offset.saturating_add(chunk.len() as u64);
        frames.push(HostFrame::Output {
            session_id: shared.cfg.session_id.clone(),
            data: chunk,
            offset: cursor.offset as u64,
            cursor,
        });
    }
    frames.push(HostFrame::ReplayDone {
        session_id: shared.cfg.session_id.clone(),
        offset: end,
        cursor: LogCursor {
            offset: end as i64,
            ..high_water.clone()
        },
        partial_context,
    });
    frames
}

/// Drains this client's broadcast channel onto the socket. A bounded receive
/// timeout lets map eviction close a writer even while the reader still holds
/// its local sender clone. Ordinary removal instead drains queued terminal
/// replies before the channel disconnects.
fn client_writer(
    stream: UnixStream,
    rx: mpsc::Receiver<OutboundFrame>,
    shared: Arc<Shared>,
    id: u64,
    closed: Arc<AtomicBool>,
    _slot: ClientSlot,
) {
    let mut w = &stream;
    loop {
        if closed.load(Ordering::Acquire) {
            break;
        }
        match rx.recv_timeout(CLIENT_WRITER_POLL) {
            Ok(frame) => {
                if closed.load(Ordering::Acquire) || write_outbound(&mut w, frame).is_err() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    disconnect_client(&shared, id);
    let _ = stream.shutdown(Shutdown::Both);
}

fn write_outbound(w: &mut impl Write, frame: OutboundFrame) -> std::io::Result<()> {
    match frame {
        OutboundFrame::Data(bytes) => w.write_all(&bytes).and_then(|_| w.flush()),
        OutboundFrame::Flush(ack) => {
            w.flush()?;
            let _ = ack.send(());
            Ok(())
        }
    }
}

/// Wait for real writer progress, not a fixed sleep. Slow/full client queues
/// retain the previous bounded drain budget; no socket I/O holds the table lock.
pub(crate) fn flush_clients(shared: &Shared, budget: Duration) {
    let queues: Vec<_> = shared
        .clients
        .lock()
        .unwrap()
        .values()
        .map(|client| client.tx.clone())
        .collect();
    flush_queues(&queues, budget);
}

fn flush_queues(queues: &[mpsc::SyncSender<OutboundFrame>], budget: Duration) {
    let deadline = Instant::now() + budget;
    let (ack, completed) = mpsc::channel();
    let mut pending = 0;
    let mut full = false;
    for queue in queues {
        match queue.try_send(OutboundFrame::Flush(ack.clone())) {
            Ok(()) => pending += 1,
            Err(mpsc::TrySendError::Full(_)) => full = true,
            Err(mpsc::TrySendError::Disconnected(_)) => {}
        }
    }
    drop(ack);
    for _ in 0..pending {
        if completed
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .is_err()
        {
            break;
        }
    }
    // A full queue could not accept a barrier; preserve its old drain allowance.
    if full {
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
    }
}

#[cfg(test)]
mod drain_tests {
    use super::*;

    #[test]
    fn flush_barrier_follows_output_and_exit_without_spending_the_drain_budget() {
        let (tx, rx) = mpsc::sync_channel(8);
        tx.send(OutboundFrame::Data(Arc::new(b"final output".to_vec())))
            .unwrap();
        tx.send(OutboundFrame::Data(Arc::new(b"exit".to_vec())))
            .unwrap();
        let writer = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            for _ in 0..3 {
                write_outbound(&mut bytes, rx.recv_timeout(Duration::from_secs(5)).unwrap())
                    .unwrap();
            }
            bytes
        });
        let start = Instant::now();
        flush_queues(&[tx], Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(writer.join().unwrap(), b"final outputexit");
    }

    #[test]
    fn nonreading_and_full_queues_cannot_hold_shutdown_indefinitely() {
        let (tx, _rx) = mpsc::sync_channel(1);
        let start = Instant::now();
        flush_queues(&[tx.clone()], Duration::from_millis(20));
        flush_queues(&[tx], Duration::from_millis(20));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn failed_socket_flush_does_not_acknowledge_the_barrier() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                unreachable!()
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
        }
        let (ack, completed) = mpsc::channel();
        assert!(write_outbound(&mut Broken, OutboundFrame::Flush(ack)).is_err());
        assert!(completed.recv().is_err());
    }
}
