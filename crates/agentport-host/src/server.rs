//! Unix socket server (PRD 3.3/3.6): one accept thread, one thread per
//! connection doing handshake -> optional tail replay -> frame loop, plus one
//! writer thread per registered client draining its broadcast channel.
//!
//! Handshake: within 5s the first frame MUST be `ClientFrame::Hello` with
//! protocol == PROTOCOL_VERSION and matching session id + token; anything
//! else gets a generic `Error` and the connection is closed (no detail about
//! which part failed — the token's correctness is never leaked).

use std::io::BufReader;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::time::Duration;

use agentport_core::protocol::{read_frame, write_frame, ClientFrame, HostFrame, PROTOCOL_VERSION};
use chrono::Utc;
use nix::sys::signal::Signal;
use portable_pty::PtySize;
use tracing::{info, warn};

use crate::{err_frame, signal_group, status_frame, HostMsg, Shared};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const REPLAY_CHUNK: usize = 64 * 1024;

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
        })) => (protocol, session_id, token, replay_tail_bytes),
        Ok(Some(_)) => {
            // Any other first frame is a protocol violation.
            reject(&stream);
            return;
        }
        Ok(None) | Err(_) => return, // EOF / timeout / garbage: close silently
    };
    let (protocol, session_id, token, replay_tail_bytes) = hello;
    if protocol != PROTOCOL_VERSION
        || session_id != shared.cfg.session_id
        || token != shared.cfg.host_token
    {
        reject(&stream);
        return;
    }
    let _ = stream.set_read_timeout(None);

    let hello_ok = HostFrame::HelloOk {
        protocol: PROTOCOL_VERSION,
        session_id: shared.cfg.session_id.clone(),
        host_pid: std::process::id(),
        child_alive: shared.child_alive.load(Ordering::Relaxed),
        log_bytes: shared.log_bytes.load(Ordering::Relaxed),
        agent_session_id: shared.agent_session_id.lock().unwrap().clone(),
    };
    if write_frame(&mut &stream, &hello_ok).is_err() {
        return;
    }

    // Tail replay happens BEFORE registration so replay frames can never
    // interleave with the live broadcast stream.
    if replay_tail_bytes > 0 && !replay_tail(&stream, &shared, replay_tail_bytes) {
        return;
    }

    // Register into the broadcast table; a writer thread owns the TX side.
    let id = shared.next_client_id.fetch_add(1, Ordering::Relaxed);
    let (frame_tx, frame_rx) = mpsc::channel::<HostFrame>();
    shared.clients.lock().unwrap().insert(id, frame_tx.clone());
    match stream.try_clone() {
        Ok(write_stream) => {
            let shared = shared.clone();
            std::thread::spawn(move || client_writer(write_stream, frame_rx, shared, id));
        }
        Err(_) => {
            shared.clients.lock().unwrap().remove(&id);
            return;
        }
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
            let _ = frame_tx.send(err_frame(None, "session id mismatch"));
            break;
        }
        match frame {
            ClientFrame::Input { data, .. } => {
                let mut w = shared.pty_writer.lock().unwrap();
                if w.write_all(&data).and_then(|_| w.flush()).is_err() {
                    break; // PTY gone — nothing more to do for this client
                }
            }
            ClientFrame::Resize { cols, rows, .. } => {
                let _ = shared.master.lock().unwrap().resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                });
            }
            ClientFrame::Interrupt { .. } => signal_group(&shared, Signal::SIGINT),
            ClientFrame::Stop { grace_ms, .. } => {
                let _ = tx.send(HostMsg::Stop { grace_ms });
            }
            ClientFrame::Ping { .. } => {
                let _ = frame_tx.send(HostFrame::Pong {
                    session_id: shared.cfg.session_id.clone(),
                    at: Utc::now(),
                });
            }
            ClientFrame::StatusRequest { .. } => {
                let cur = shared.current_status.lock().unwrap().clone();
                if let Some(ev) = cur {
                    let _ = frame_tx.send(status_frame(&ev));
                }
            }
            ClientFrame::Detach { .. } => {
                // Deterministic close: drop from the broadcast table first so no
                // further heartbeats race in, then shut the socket down so the
                // client sees EOF immediately (GUI detach path, PRD 3.3).
                shared.clients.lock().unwrap().remove(&id);
                let _ = stream.shutdown(std::net::Shutdown::Both);
                break;
            }
            ClientFrame::Hello { .. } => {
                let _ = frame_tx.send(err_frame(None, "duplicate hello"));
                break;
            }
        }
    }
    shared.clients.lock().unwrap().remove(&id);
    info!(client_id = id, "client detached");
}

/// One generic rejection — never reveal which credential part failed.
fn reject(stream: &UnixStream) {
    let _ = write_frame(&mut &*stream, &err_frame(None, "handshake rejected"));
}

fn frame_session_id(f: &ClientFrame) -> &str {
    match f {
        ClientFrame::Hello { session_id, .. }
        | ClientFrame::Input { session_id, .. }
        | ClientFrame::Resize { session_id, .. }
        | ClientFrame::Interrupt { session_id }
        | ClientFrame::Stop { session_id, .. }
        | ClientFrame::StatusRequest { session_id }
        | ClientFrame::Ping { session_id }
        | ClientFrame::Detach { session_id } => session_id,
    }
}

/// Replay the log tail as Output frames (generation offsets), then ReplayDone.
fn replay_tail(stream: &UnixStream, shared: &Shared, tail_bytes: u64) -> bool {
    let path = PathBuf::from(&shared.cfg.log_path);
    let data = agentport_core::logs::tail_bytes(&path, tail_bytes).unwrap_or_default();
    let file_len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let start = file_len.saturating_sub(data.len() as u64);
    let mut w = stream;
    for (i, chunk) in data.chunks(REPLAY_CHUNK).enumerate() {
        let frame = HostFrame::Output {
            session_id: shared.cfg.session_id.clone(),
            data: chunk.to_vec(),
            offset: start + (i * REPLAY_CHUNK) as u64,
        };
        if write_frame(&mut w, &frame).is_err() {
            return false;
        }
    }
    write_frame(
        &mut w,
        &HostFrame::ReplayDone {
            session_id: shared.cfg.session_id.clone(),
            offset: start + data.len() as u64,
        },
    )
    .is_ok()
}

/// Drains this client's broadcast channel onto the socket. Ends when the
/// channel closes (client detached / host shutting down) or the write fails.
fn client_writer(stream: UnixStream, rx: mpsc::Receiver<HostFrame>, shared: Arc<Shared>, id: u64) {
    let mut w = &stream;
    while let Ok(frame) = rx.recv() {
        if write_frame(&mut w, &frame).is_err() {
            break;
        }
    }
    shared.clients.lock().unwrap().remove(&id);
}
