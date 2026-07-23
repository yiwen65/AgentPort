//! Unix socket server (PRD 3.3/3.6): one accept thread, one thread per
//! connection doing handshake -> optional tail replay -> frame loop, plus one
//! writer thread per registered client draining its broadcast channel.
//!
//! Handshake: within 5s the first frame MUST be `ClientFrame::Hello` with
//! protocol == PROTOCOL_VERSION and matching session id + token; anything
//! else gets a generic `Error` and the connection is closed (no detail about
//! which part failed — the token's correctness is never leaked).

use std::io::{BufReader, Read, Seek, SeekFrom};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use agentport_core::models::{AgentTransport, LogCursor};
use agentport_core::protocol::{read_frame, write_frame, ClientFrame, HostFrame, PROTOCOL_VERSION};
use chrono::Utc;
use nix::sys::signal::Signal;
use portable_pty::PtySize;
use tracing::{info, warn};

use crate::{current_log_cursor, err_frame, signal_group, status_frame, HostMsg, Shared};

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

/// One entry in the Host broadcast table. The sender is bounded; an explicit
/// eviction closes the socket so the reader and writer threads for that one
/// client both wake and exit. Ordinary removal lets already-enqueued terminal
/// replies drain in order before the channel closes.
pub(crate) struct ClientSink {
    pub(crate) tx: mpsc::SyncSender<HostFrame>,
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
    let (frame_tx, frame_rx) = mpsc::sync_channel::<HostFrame>(CLIENT_OUTBOUND_QUEUE_CAPACITY);
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
        }];
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
            if frame_tx.try_send(frame).is_err() {
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
                err_frame(None, "session id mismatch"),
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
                            "terminal input is unavailable for structured sessions",
                        ),
                    );
                    continue;
                }
                let mut w = shared.input_writer.lock().unwrap();
                if w.write_all(&data).and_then(|_| w.flush()).is_err() {
                    break; // PTY gone — nothing more to do for this client
                }
            }
            ClientFrame::StructuredPrompt { text, .. } => {
                if shared.cfg.transport != AgentTransport::JsonRpc {
                    let _ = queue_client_frame(
                        &shared,
                        id,
                        &frame_tx,
                        err_frame(
                            Some(&shared.cfg.session_id),
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
            }
            ClientFrame::AbortStructuredTurn { .. } => {
                if shared.cfg.transport != AgentTransport::JsonRpc {
                    let _ = queue_client_frame(
                        &shared,
                        id,
                        &frame_tx,
                        err_frame(
                            Some(&shared.cfg.session_id),
                            "structured abort requires json_rpc transport",
                        ),
                    );
                    continue;
                }
                if write_json_command(&shared, serde_json::json!({"type": "abort"})).is_err() {
                    break;
                }
            }
            ClientFrame::Resize { cols, rows, .. } => {
                if let Some(master) = shared.master.lock().unwrap().as_mut() {
                    let _ = master.resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    });
                }
            }
            ClientFrame::Interrupt { .. } => signal_group(&shared, Signal::SIGINT),
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
                let _ =
                    queue_client_frame(&shared, id, &frame_tx, err_frame(None, "duplicate hello"));
                break;
            }
        }
    }
    remove_client(&shared, id);
    info!(client_id = id, "client detached");
}

/// Queue a client-specific reply without ever blocking the connection reader.
/// If this client cannot keep up, evict only it and shut down its socket.
fn queue_client_frame(
    shared: &Shared,
    id: u64,
    tx: &mpsc::SyncSender<HostFrame>,
    frame: HostFrame,
) -> bool {
    match tx.try_send(frame) {
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
    let _ = write_frame(&mut &*stream, &err_frame(None, "handshake rejected"));
}

fn frame_session_id(f: &ClientFrame) -> &str {
    match f {
        ClientFrame::Hello { session_id, .. }
        | ClientFrame::Input { session_id, .. }
        | ClientFrame::StructuredPrompt { session_id, .. }
        | ClientFrame::AbortStructuredTurn { session_id }
        | ClientFrame::Resize { session_id, .. }
        | ClientFrame::Interrupt { session_id }
        | ClientFrame::Stop { session_id, .. }
        | ClientFrame::StatusRequest { session_id }
        | ClientFrame::Ping { session_id }
        | ClientFrame::Detach { session_id } => session_id,
    }
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
    let current_offset = high_water.offset.max(0) as u64;
    let bounded_tail = tail_bytes.min(MAX_REPLAY_BYTES);
    let tail_start = current_offset.saturating_sub(bounded_tail);
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
        Some(cursor) if cursor.offset < 0 || cursor.offset > high_water.offset => {
            resync_reason = Some("cursor offset is outside the retained log".into());
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
            target.saturating_sub(BEFORE)
        }
        Some(cursor) => cursor.offset as u64,
    };

    let path = PathBuf::from(&shared.cfg.log_path);
    let mut data = match read_log_range(&path, start, end) {
        Ok(data) => data,
        Err(error) => {
            if (resume_from.is_some() || replay_target.is_some()) && resync_reason.is_none() {
                resync_reason = Some(format!("requested log range is unavailable: {error}"));
                start = tail_start;
                end = current_offset;
                read_log_range(&path, start, end).unwrap_or_default()
            } else {
                Vec::new()
            }
        }
    };
    // A failed tail read must never claim offsets for bytes that were not
    // queued. Reset the tail to an empty snapshot at the captured high-water.
    if data.len() as u64 != end.saturating_sub(start) {
        data.clear();
        start = end;
        resync_reason.get_or_insert_with(|| "retained log changed during replay".into());
    }

    let mut frames = Vec::with_capacity(
        2 + data.len().div_ceil(REPLAY_CHUNK) + usize::from(resync_reason.is_some()),
    );
    let partial_context = replay_target.is_some() && resync_reason.is_none();
    if let Some(reason) = resync_reason {
        let mut earliest = high_water.clone();
        earliest.offset = 0;
        frames.push(HostFrame::ResyncRequired {
            session_id: shared.cfg.session_id.clone(),
            earliest,
            reason,
        });
    }
    for (index, chunk) in data.chunks(REPLAY_CHUNK).enumerate() {
        let offset = start + (index * REPLAY_CHUNK) as u64;
        let mut cursor = high_water.clone();
        cursor.offset = offset as i64;
        frames.push(HostFrame::Output {
            session_id: shared.cfg.session_id.clone(),
            data: chunk.to_vec(),
            offset,
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

fn read_log_range(path: &PathBuf, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    if start > end {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "replay start exceeds high-water",
        ));
    }
    let mut file = std::fs::File::open(path)?;
    if file.metadata()?.len() < end {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "log is shorter than captured high-water",
        ));
    }
    file.seek(SeekFrom::Start(start))?;
    let mut data = Vec::with_capacity((end - start) as usize);
    file.take(end - start).read_to_end(&mut data)?;
    Ok(data)
}

/// Drains this client's broadcast channel onto the socket. A bounded receive
/// timeout lets map eviction close a writer even while the reader still holds
/// its local sender clone. Ordinary removal instead drains queued terminal
/// replies before the channel disconnects.
fn client_writer(
    stream: UnixStream,
    rx: mpsc::Receiver<HostFrame>,
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
                if closed.load(Ordering::Acquire) || write_frame(&mut w, &frame).is_err() {
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
