use agentport_remote_protocol::{
    SessionAttachParams, SessionControlKind, SessionControlParams, SessionDetachParams,
    SessionInputParams,
};
use agentport_service::{CoreService, RemoteService, SessionEvent};
use base64::Engine as _;
use signal_hook::consts::signal::SIGWINCH;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use zeroize::Zeroizing;

const INPUT_CHUNK_BYTES: usize = 16 * 1024;

fn session_arg() -> Result<String, ()> {
    let mut args = std::env::args().skip(1);
    match (args.next().as_deref(), args.next(), args.next()) {
        (Some("--session"), Some(session_id), None)
            if !session_id.is_empty()
                && session_id.len() <= 128
                && session_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) =>
        {
            Ok(session_id)
        }
        _ => Err(()),
    }
}

fn terminal_size() -> Option<(u16, u16)> {
    let mut size = std::mem::MaybeUninit::<libc::winsize>::zeroed();
    if unsafe { libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, size.as_mut_ptr()) } != 0 {
        return None;
    }
    let size = unsafe { size.assume_init() };
    (size.ws_col > 0 && size.ws_row > 0).then_some((size.ws_col, size.ws_row))
}

fn resize(service: &CoreService, attachment_id: &str) -> Result<(), ()> {
    let Some((cols, rows)) = terminal_size() else {
        return Ok(());
    };
    service
        .control_session(SessionControlParams {
            attachment_id: attachment_id.to_string(),
            control: SessionControlKind::Resize,
            cols: Some(cols),
            rows: Some(rows),
            expected_revision: None,
            source_kind: None,
            source_device_id: None,
            orientation: None,
        })
        .map(|_| ())
        .map_err(|_| ())
}

fn event_bytes(event: &SessionEvent) -> Result<Option<Vec<u8>>, ()> {
    match event.event_type.as_str() {
        "output" | "transient_output" => {
            let encoded = event
                .payload
                .get("data")
                .and_then(serde_json::Value::as_str)
                .ok_or(())?;
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map(Some)
                .map_err(|_| ())
        }
        "gap" | "resync_required" | "error" => Err(()),
        _ => Ok(None),
    }
}

fn input_worker(service: Arc<CoreService>, attachment_id: String, done: Arc<AtomicBool>) {
    let mut input = io::stdin().lock();
    let mut buffer = Zeroizing::new(vec![0_u8; INPUT_CHUNK_BYTES]);
    let mut sequence = 0_u64;
    loop {
        let count = match input.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => count,
        };
        sequence = match sequence.checked_add(1) {
            Some(sequence) => sequence,
            None => break,
        };
        let encoded =
            Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&buffer[..count]));
        if service
            .input_session(SessionInputParams {
                attachment_id: attachment_id.clone(),
                batch_id: format!("mosh-{sequence}"),
                data_base64: encoded,
            })
            .is_err()
        {
            break;
        }
    }
    done.store(true, Ordering::Release);
}

fn run(session_id: String) -> Result<(), ()> {
    let service = Arc::new(CoreService::open_default().map_err(|_| ())?);
    let attached = service
        .attach_session(SessionAttachParams {
            session_id,
            replay_tail_bytes: 0,
            screen_snapshot: false,
            resume_from: None,
            subscribe_output: true,
        })
        .map_err(|_| ())?;
    let attachment_id = attached.attachment_id;
    let subscription = service.subscribe_session(&attachment_id).map_err(|_| ())?;
    let resize_pending = Arc::new(AtomicBool::new(true));
    signal_hook::flag::register(SIGWINCH, Arc::clone(&resize_pending)).map_err(|_| ())?;
    let input_done = Arc::new(AtomicBool::new(false));
    let worker_service = Arc::clone(&service);
    let worker_attachment = attachment_id.clone();
    let worker_done = Arc::clone(&input_done);
    std::thread::spawn(move || input_worker(worker_service, worker_attachment, worker_done));

    let mut output = io::stdout().lock();
    let outcome = loop {
        if resize_pending.swap(false, Ordering::AcqRel) && resize(&service, &attachment_id).is_err()
        {
            break Err(());
        }
        match subscription.recv_timeout(Duration::from_millis(50)) {
            Ok(event) => {
                let is_exit = event.event_type == "exit";
                match event_bytes(&event) {
                    Ok(Some(bytes)) if output.write_all(&bytes).is_err() => break Err(()),
                    Ok(_) if is_exit => break Ok(()),
                    Ok(_) => {}
                    Err(()) => break Err(()),
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if input_done.load(Ordering::Acquire) {
                    break Ok(());
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break Err(()),
        }
    };
    let _ = service.detach_session(SessionDetachParams { attachment_id });
    outcome
}

fn main() {
    let session_id = match session_arg() {
        Ok(session_id) => session_id,
        Err(()) => {
            let _ = writeln!(
                io::stderr(),
                "usage: agentport-mosh-attach --session <session-id>"
            );
            std::process::exit(2);
        }
    };
    if run(session_id).is_err() {
        let _ = writeln!(io::stderr(), "agentport Mosh attach failed");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentport_remote_protocol::RunCursor;

    #[test]
    fn output_event_decodes_only_terminal_bytes() {
        let event = SessionEvent {
            event_type: "output".into(),
            cursor: RunCursor {
                run_id: "run".into(),
                run_ordinal: 1,
                generation: 1,
                offset: 2,
                status_sequence: 3,
            },
            payload: serde_json::json!({"type":"output","data":"b2s="}),
        };
        assert_eq!(event_bytes(&event).unwrap(), Some(b"ok".to_vec()));
    }

    #[test]
    fn resync_and_gap_fail_closed() {
        for event_type in ["gap", "resync_required", "error"] {
            let event = SessionEvent {
                event_type: event_type.into(),
                cursor: RunCursor {
                    run_id: "run".into(),
                    run_ordinal: 1,
                    generation: 1,
                    offset: 0,
                    status_sequence: 0,
                },
                payload: serde_json::json!({}),
            };
            assert!(event_bytes(&event).is_err());
        }
    }
}
