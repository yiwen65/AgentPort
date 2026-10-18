//! Per-attachment desktop input flow control. Socket delivery alone does not
//! prove that the Host's bounded input executor accepted or wrote the bytes.

use agentport_core::protocol::{write_frame, ClientFrame, InputBatchAckPhase};
use std::sync::Mutex;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::HostWriter;

const UNKNOWN_COMPLETION: &str =
    "Terminal input completion is unknown. It was not resent automatically; reconnect before sending more input.";

struct PendingInput {
    batch_id: String,
    accepted_sequence: Option<u64>,
    result: oneshot::Sender<Result<(), String>>,
}

#[derive(Default)]
struct InputState {
    next_batch_id: u64,
    closed: bool,
    pending: Option<PendingInput>,
}

pub(crate) struct DesktopInput {
    // Independent descriptor: closing must interrupt a blocked socket write
    // without waiting for the writer mutex held by that same write.
    shutdown: std::os::unix::net::UnixStream,
    supports_batches: bool,
    serial: AsyncMutex<()>,
    state: Mutex<InputState>,
}

impl DesktopInput {
    pub(crate) fn new(supports_batches: bool, shutdown: std::os::unix::net::UnixStream) -> Self {
        Self {
            shutdown,
            supports_batches,
            serial: AsyncMutex::new(()),
            state: Mutex::new(InputState::default()),
        }
    }

    pub(crate) async fn send(
        &self,
        writer: HostWriter,
        session_id: String,
        data: Vec<u8>,
    ) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        // One outstanding batch per attachment provides PTY backpressure even
        // if IPC callers are concurrent. Never hold the socket lock awaiting it.
        let _serial = self.serial.lock().await;
        let (frame, completion) = {
            let mut state = self.state.lock().unwrap();
            if state.closed || state.pending.is_some() {
                return Err(UNKNOWN_COMPLETION.into());
            }
            if self.supports_batches {
                state.next_batch_id += 1;
                let batch_id = format!("desktop-{}", state.next_batch_id);
                let (result, completion) = oneshot::channel();
                state.pending = Some(PendingInput {
                    batch_id: batch_id.clone(),
                    accepted_sequence: None,
                    result,
                });
                (
                    ClientFrame::InputBatch {
                        session_id,
                        batch_id,
                        data,
                    },
                    Some(completion),
                )
            } else {
                // Old Hosts do not understand InputBatch. Preserve their
                // socket-only semantics, without sending an unsupported frame.
                (ClientFrame::Input { session_id, data }, None)
            }
        };
        // A backed-up socket must not block Tauri's async worker or other
        // Sessions. Do not retry a failed write: a prefix may have executed.
        let sent =
            tokio::task::spawn_blocking(move || write_frame(&mut *writer.lock().unwrap(), &frame))
                .await;
        if !matches!(sent, Ok(Ok(()))) {
            self.close();
            return Err(UNKNOWN_COMPLETION.into());
        }
        match completion {
            Some(completion) => completion
                .await
                .unwrap_or_else(|_| Err(UNKNOWN_COMPLETION.into())),
            None => Ok(()),
        }
    }

    pub(crate) fn acknowledge(
        &self,
        batch_id: &str,
        sequence: u64,
        phase: InputBatchAckPhase,
        message: Option<String>,
    ) {
        let mut state = self.state.lock().unwrap();
        let Some(pending) = state
            .pending
            .as_mut()
            .filter(|pending| pending.batch_id == batch_id)
        else {
            return;
        };
        let result = match phase {
            InputBatchAckPhase::Accepted => {
                pending.accepted_sequence.get_or_insert(sequence);
                return;
            }
            InputBatchAckPhase::Completed if pending.accepted_sequence == Some(sequence) => Ok(()),
            InputBatchAckPhase::NotExecuted
                if pending.accepted_sequence.is_none()
                    || pending.accepted_sequence == Some(sequence) =>
            {
                Err(format!(
                    "Terminal input was not executed: {}. It was not resent automatically.",
                    message.as_deref().unwrap_or("Host rejected the input")
                ))
            }
            InputBatchAckPhase::Unknown if pending.accepted_sequence == Some(sequence) => {
                state.closed = true;
                Err(UNKNOWN_COMPLETION.into())
            }
            _ => return,
        };
        if let Some(pending) = state.pending.take() {
            let _ = pending.result.send(result);
        }
    }

    /// Detach/replacement/EOF cannot strand a caller waiting for an ACK that
    /// belonged to the old connection. Never replay it onto the new one.
    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        if let Some(pending) = state.pending.take() {
            let _ = pending.result.send(Err(UNKNOWN_COMPLETION.into()));
        }
        drop(state);
        let _ = self.shutdown.shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentport_core::protocol::read_frame;
    use std::io::BufReader;
    use std::os::unix::net::UnixStream;
    use std::sync::Arc;
    use std::time::Duration;

    fn run(future: impl std::future::Future<Output = ()>) {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(future);
    }

    async fn receive(reader: BufReader<UnixStream>) -> (BufReader<UnixStream>, ClientFrame) {
        tokio::task::spawn_blocking(move || {
            let mut reader = reader;
            let frame = read_frame(&mut reader).unwrap().unwrap();
            (reader, frame)
        })
        .await
        .unwrap()
    }

    fn batch(frame: ClientFrame) -> (String, Vec<u8>) {
        match frame {
            ClientFrame::InputBatch { batch_id, data, .. } => (batch_id, data),
            other => panic!("expected acknowledged input batch, got {other:?}"),
        }
    }

    fn start_send(
        input: Arc<DesktopInput>,
        writer: HostWriter,
        data: Vec<u8>,
    ) -> tokio::task::JoinHandle<Result<(), String>> {
        tokio::spawn(async move { input.send(writer, "session".into(), data).await })
    }

    #[test]
    fn desktop_input_backpressures_more_than_a_host_queue_of_concurrent_calls() {
        run(async {
            let (writer, peer) = UnixStream::pair().unwrap();
            let input = Arc::new(DesktopInput::new(true, writer.try_clone().unwrap()));
            peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let writer = Arc::new(Mutex::new(writer));
            let mut first = start_send(input.clone(), writer.clone(), b"first".to_vec());
            let (reader, frame) = receive(BufReader::new(peer)).await;
            let (first_id, _) = batch(frame);
            let calls = (0..150u16)
                .map(|n| start_send(input.clone(), writer.clone(), n.to_le_bytes().to_vec()))
                .collect::<Vec<_>>();
            input.acknowledge(&first_id, 1, InputBatchAckPhase::Accepted, None);
            assert!(tokio::time::timeout(Duration::from_millis(30), &mut first)
                .await
                .is_err());
            // There must be no second input on the socket while the first PTY
            // write is blocked, even though >128 IPC calls are ready to send.
            let mut reader = tokio::task::spawn_blocking(move || {
                let mut reader = reader;
                reader
                    .get_ref()
                    .set_read_timeout(Some(Duration::from_millis(30)))
                    .unwrap();
                let error = read_frame::<ClientFrame>(&mut reader).unwrap_err();
                assert!(matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ));
                reader
                    .get_ref()
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                reader
            })
            .await
            .unwrap();
            input.acknowledge(&first_id, 1, InputBatchAckPhase::Completed, None);
            assert!(first.await.unwrap().is_ok());
            let mut seen = std::collections::HashSet::new();
            for sequence in 2..152 {
                let (next_reader, frame) = receive(reader).await;
                reader = next_reader;
                let (id, data) = batch(frame);
                assert!(seen.insert(data));
                input.acknowledge(&id, sequence, InputBatchAckPhase::Accepted, None);
                input.acknowledge(&id, sequence, InputBatchAckPhase::Completed, None);
            }
            for call in calls {
                assert!(call.await.unwrap().is_ok());
            }
            assert_eq!(seen.len(), 150);
        });
    }

    #[test]
    fn acknowledgements_are_scoped_and_unknown_completion_is_never_retried() {
        run(async {
            let (writer, peer) = UnixStream::pair().unwrap();
            let input = Arc::new(DesktopInput::new(true, writer.try_clone().unwrap()));
            let writer = Arc::new(Mutex::new(writer));
            let mut call = start_send(input.clone(), writer.clone(), b"once".to_vec());
            let (_reader, frame) = receive(BufReader::new(peer)).await;
            let (id, _) = batch(frame);
            input.acknowledge("other-batch", 1, InputBatchAckPhase::Completed, None);
            input.acknowledge(&id, 1, InputBatchAckPhase::Completed, None);
            input.acknowledge(&id, 2, InputBatchAckPhase::Accepted, None);
            input.acknowledge(&id, 1, InputBatchAckPhase::Completed, None);
            assert!(tokio::time::timeout(Duration::from_millis(30), &mut call)
                .await
                .is_err());
            input.acknowledge(&id, 2, InputBatchAckPhase::Unknown, None);
            assert!(call.await.unwrap().unwrap_err().contains("unknown"));
            assert!(input
                .send(writer, "session".into(), b"later".to_vec())
                .await
                .is_err());
        });
    }

    #[test]
    fn explicit_rejection_is_not_retried_and_later_input_can_recover() {
        run(async {
            let (writer, peer) = UnixStream::pair().unwrap();
            let input = Arc::new(DesktopInput::new(true, writer.try_clone().unwrap()));
            let writer = Arc::new(Mutex::new(writer));
            let call = start_send(input.clone(), writer.clone(), b"rejected".to_vec());
            let (reader, frame) = receive(BufReader::new(peer)).await;
            let (id, _) = batch(frame);
            input.acknowledge(
                &id,
                1,
                InputBatchAckPhase::NotExecuted,
                Some("input queue is full".into()),
            );
            assert!(call
                .await
                .unwrap()
                .unwrap_err()
                .contains("input queue is full"));
            let later = start_send(input.clone(), writer, b"later".to_vec());
            let (_reader, frame) = receive(reader).await;
            let (next_id, data) = batch(frame);
            assert_eq!(data, b"later");
            assert_ne!(next_id, id);
            input.acknowledge(&next_id, 2, InputBatchAckPhase::Accepted, None);
            input.acknowledge(&next_id, 2, InputBatchAckPhase::Completed, None);
            assert!(later.await.unwrap().is_ok());
        });
    }

    #[test]
    fn closing_an_attachment_releases_pending_and_queued_calls() {
        run(async {
            let (writer, peer) = UnixStream::pair().unwrap();
            let input = Arc::new(DesktopInput::new(true, writer.try_clone().unwrap()));
            let writer = Arc::new(Mutex::new(writer));
            let first = start_send(input.clone(), writer.clone(), b"first".to_vec());
            let (_reader, frame) = receive(BufReader::new(peer)).await;
            let (id, _) = batch(frame);
            let second = start_send(input.clone(), writer, b"second".to_vec());
            input.close();
            input.acknowledge(&id, 1, InputBatchAckPhase::Completed, None);
            assert!(first.await.unwrap().is_err());
            assert!(second.await.unwrap().is_err());
        });
    }

    #[test]
    fn closing_an_attachment_interrupts_a_blocked_socket_write() {
        run(async {
            let (writer, _peer) = UnixStream::pair().unwrap();
            let input = Arc::new(DesktopInput::new(true, writer.try_clone().unwrap()));
            let cleanup = writer.try_clone().unwrap();
            let writer = Arc::new(Mutex::new(writer));
            let mut first = start_send(input.clone(), writer.clone(), vec![b'x'; 256 * 1024]);
            tokio::time::timeout(Duration::from_secs(2), async {
                loop {
                    if writer.try_lock().is_err() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            })
            .await
            .unwrap();
            let second = start_send(input.clone(), writer, b"queued".to_vec());
            input.close();
            let result = tokio::time::timeout(Duration::from_millis(100), &mut first).await;
            // Shut down the writing endpoint itself: peer shutdown does not
            // reliably wake a blocked send on macOS. Always clean up even on
            // the pre-fix failure path so spawn_blocking cannot strand the test.
            let _ = cleanup.shutdown(std::net::Shutdown::Both);
            let closed_promptly = result.is_ok();
            if let Ok(result) = result {
                assert!(result.unwrap().is_err());
            } else {
                assert!(first.await.unwrap().is_err());
            }
            assert!(second.await.unwrap().is_err());
            assert!(
                closed_promptly,
                "close must interrupt a socket write without acquiring its writer mutex"
            );
        });
    }

    #[test]
    fn old_hosts_keep_legacy_frames_and_socket_completion() {
        run(async {
            let (writer, peer) = UnixStream::pair().unwrap();
            let input = Arc::new(DesktopInput::new(false, writer.try_clone().unwrap()));
            let writer = Arc::new(Mutex::new(writer));
            let call = start_send(input, writer, b"legacy".to_vec());
            let (_reader, frame) = receive(BufReader::new(peer)).await;
            assert!(matches!(frame, ClientFrame::Input { data, .. } if data == b"legacy"));
            assert!(call.await.unwrap().is_ok());
        });
    }

    #[test]
    fn desktop_input_waits_for_host_completion_without_blocking_control() {
        run(async {
            let (writer, peer) = UnixStream::pair().unwrap();
            let input = Arc::new(DesktopInput::new(true, writer.try_clone().unwrap()));
            peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let writer = Arc::new(Mutex::new(writer));
            let first_input = input.clone();
            let first_writer = writer.clone();
            let mut first = tokio::spawn(async move {
                first_input
                    .send(first_writer, "session".into(), b"first".to_vec())
                    .await
            });
            let (reader, frame) = receive(BufReader::new(peer)).await;
            let (id, data) = batch(frame);
            assert_eq!(data, b"first");
            input.acknowledge(&id, 1, InputBatchAckPhase::Accepted, None);
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut first)
                    .await
                    .is_err(),
                "socket write/accepted is not PTY completion"
            );
            // Waiting for input must not retain the socket writer lock: resize,
            // interrupt, stop and other control frames use this same writer.
            write_frame(
                &mut *writer.lock().unwrap(),
                &ClientFrame::Ping {
                    session_id: "session".into(),
                },
            )
            .unwrap();
            let (reader, frame) = receive(reader).await;
            assert!(matches!(frame, ClientFrame::Ping { .. }));
            input.acknowledge(&id, 1, InputBatchAckPhase::Completed, None);
            assert!(first.await.unwrap().is_ok());
            drop(reader);
        });
    }
}
