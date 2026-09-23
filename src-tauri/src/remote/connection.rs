//! One framed client connection to a remote bridge.
//!
//! Owns a dedicated reader thread that dispatches inbound envelopes:
//! results are correlated to pending requests by `request_id`, events are
//! fanned out to subscribers. All public methods are blocking and designed
//! to run inside `spawn_blocking`; they never touch the Tauri async runtime.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use agentport_remote_protocol::{
    ClientIdentity, Hello, HelloType, ProtocolVersion, Request, RequestType, ResultStatus,
    ServerEnvelope,
};
use serde_json::Value;

use crate::remote::transport::{FrameReader, FrameWriter};
use crate::remote::{RemoteCommandError, RemoteEventMsg};

/// Capabilities the desktop client always asks for during the handshake.
pub const REQUESTED_CAPABILITIES: &[&str] = &[
    agentport_remote_protocol::CAPABILITY_SESSION_EVENT_PUSH,
    agentport_remote_protocol::CAPABILITY_TERMINAL_GEOMETRY,
];

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// Event subscriber: returns `false` when its consumer is gone and should
/// be pruned (e.g. the webview that owned the Channel was reloaded).
pub type Subscriber = Arc<dyn Fn(&RemoteEventMsg) -> bool + Send + Sync>;

enum PendingReply {
    Envelope(Box<ServerEnvelope>),
    Closed(String),
}

struct Shared {
    pending: Mutex<HashMap<String, mpsc::Sender<PendingReply>>>,
    subscribers: Mutex<Vec<Subscriber>>,
    /// One-shot waiter completing the Hello handshake from the reader loop.
    hello_waiter: Mutex<Option<mpsc::Sender<PendingReply>>>,
    closed: AtomicBool,
    close_reason: Mutex<Option<String>>,
}

impl Shared {
    /// Marks the connection closed, fails every pending request and notifies
    /// subscribers with a synthetic `transport_closed` control event.
    fn close(&self, reason: &str) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        *self.close_reason.lock().unwrap() = Some(reason.to_string());
        if let Some(waiter) = self.hello_waiter.lock().unwrap().take() {
            let _ = waiter.send(PendingReply::Closed(reason.to_string()));
        }
        let mut pending = self.pending.lock().unwrap();
        for (_, waiter) in pending.drain() {
            let _ = waiter.send(PendingReply::Closed(reason.to_string()));
        }
        drop(pending);
        let msg = RemoteEventMsg {
            subscription_id: String::new(),
            event_type: "transport_closed".to_string(),
            cursor: None,
            payload: Value::String(reason.to_string()),
        };
        self.subscribers
            .lock()
            .unwrap()
            .retain(|subscriber| subscriber(&msg));
    }
}

pub struct RemoteConnection {
    writer: Mutex<Box<dyn FrameWriter>>,
    shared: Arc<Shared>,
    next_request: AtomicU64,
    reader_thread: Mutex<Option<JoinHandle<()>>>,
    hello: agentport_remote_protocol::HelloResult,
}

impl RemoteConnection {
    /// Sends Hello, starts the dispatch reader thread and waits for the
    /// handshake to complete through it — no socket-level timeouts involved.
    pub fn establish(
        reader: Box<dyn FrameReader>,
        writer: Box<dyn FrameWriter>,
        client: ClientIdentity,
    ) -> Result<Arc<Self>, RemoteCommandError> {
        let hello = Hello {
            message_type: HelloType::Hello,
            protocol: ProtocolVersion::V1,
            client,
            requested_capabilities: REQUESTED_CAPABILITIES
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
        };
        let payload = serde_json::to_vec(&hello)
            .map_err(|error| RemoteCommandError::new("hello_encode_failed", error.to_string()))?;
        let mut writer = writer;
        writer
            .write_frame(&payload)
            .map_err(|error| RemoteCommandError::new(error.code(), error.to_string()))?;

        let (hello_tx, hello_rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            subscribers: Mutex::new(Vec::new()),
            hello_waiter: Mutex::new(Some(hello_tx)),
            closed: AtomicBool::new(false),
            close_reason: Mutex::new(None),
        });
        // The reader thread holds only `Shared`, never an Arc back to the
        // connection: a dropped connection can actually die once its writer
        // shutdown wakes the reader, leaving no reference cycle behind.
        let reader_shared = Arc::clone(&shared);
        let handle = std::thread::Builder::new()
            .name("agentport-remote-reader".into())
            .spawn(move || Self::reader_loop(reader, reader_shared))
            .map_err(|error| RemoteCommandError::new("reader_spawn_failed", error.to_string()))?;

        let handshake = hello_rx.recv_timeout(HANDSHAKE_TIMEOUT);
        let hello_result = match handshake {
            Ok(PendingReply::Envelope(envelope)) => match *envelope {
                ServerEnvelope::Hello(result) => result,
                ServerEnvelope::Incompatible { supported, message } => {
                    Self::abort_handshake(&shared, &mut writer, handle);
                    return Err(RemoteCommandError::new(
                        "protocol_incompatible",
                        format!(
                            "remote supports protocol {}.{}: {message}",
                            supported.major, supported.minor
                        ),
                    ));
                }
                _ => {
                    Self::abort_handshake(&shared, &mut writer, handle);
                    return Err(RemoteCommandError::new(
                        "hello_invalid",
                        "first bridge frame was not a Hello result",
                    ));
                }
            },
            Ok(PendingReply::Closed(reason)) => {
                Self::abort_handshake(&shared, &mut writer, handle);
                return Err(RemoteCommandError::new("bridge_closed", reason));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Self::abort_handshake(&shared, &mut writer, handle);
                return Err(RemoteCommandError::new(
                    "hello_timeout",
                    "bridge did not answer Hello",
                ));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Self::abort_handshake(&shared, &mut writer, handle);
                return Err(RemoteCommandError::new(
                    "bridge_closed",
                    "bridge closed during Hello",
                ));
            }
        };

        Ok(Arc::new(Self {
            writer: Mutex::new(writer),
            shared,
            next_request: AtomicU64::new(1),
            reader_thread: Mutex::new(Some(handle)),
            hello: hello_result,
        }))
    }

    /// Failed-handshake cleanup: wake the reader via the writer's close
    /// semantics, then join it so no thread outlives the error return.
    fn abort_handshake(
        shared: &Arc<Shared>,
        writer: &mut Box<dyn FrameWriter>,
        handle: JoinHandle<()>,
    ) {
        writer.shutdown();
        shared.close("handshake aborted");
        let _ = handle.join();
    }

    pub fn hello(&self) -> &agentport_remote_protocol::HelloResult {
        &self.hello
    }

    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }

    fn reader_loop(mut reader: Box<dyn FrameReader>, shared: Arc<Shared>) {
        let close_reason = loop {
            match reader.read_frame() {
                Ok(Some(frame)) => Self::dispatch(&shared, &frame),
                Ok(None) => break "peer closed the transport".to_string(),
                Err(error) => break error.to_string(),
            }
        };
        shared.close(&close_reason);
    }

    fn dispatch(shared: &Arc<Shared>, frame: &[u8]) {
        let envelope: ServerEnvelope = match serde_json::from_slice(frame) {
            Ok(envelope) => envelope,
            Err(error) => {
                tracing::warn!(%error, "remote: dropping undecodable bridge frame");
                return;
            }
        };
        match envelope {
            ServerEnvelope::Result { ref request_id, .. } => {
                let waiter = shared.pending.lock().unwrap().remove(request_id);
                if let Some(waiter) = waiter {
                    let _ = waiter.send(PendingReply::Envelope(Box::new(envelope)));
                }
            }
            ServerEnvelope::Accepted { ref request_id, .. } => {
                // Accepted precedes the terminal Result: keep the waiter
                // registered, just forward the acknowledgement.
                let waiter = shared.pending.lock().unwrap().get(request_id).cloned();
                if let Some(waiter) = waiter {
                    let _ = waiter.send(PendingReply::Envelope(Box::new(envelope)));
                }
            }
            ServerEnvelope::Event(event) => {
                let msg = RemoteEventMsg {
                    subscription_id: event.subscription_id,
                    event_type: event.event_type,
                    cursor: Some(event.cursor),
                    payload: event.payload,
                };
                shared
                    .subscribers
                    .lock()
                    .unwrap()
                    .retain(|subscriber| subscriber(&msg));
            }
            ServerEnvelope::Hello(_) | ServerEnvelope::Incompatible { .. } => {
                let waiter = shared.hello_waiter.lock().unwrap().take();
                match waiter {
                    Some(waiter) => {
                        let _ = waiter.send(PendingReply::Envelope(Box::new(envelope)));
                    }
                    None => {
                        tracing::warn!("remote: unexpected post-handshake Hello frame");
                    }
                }
            }
        }
    }

    fn close(&self, reason: &str) {
        self.shared.close(reason);
    }

    /// Sends one request and waits for its terminal `Result` envelope.
    /// Intermediate `Accepted` frames are consumed and logged.
    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RemoteCommandError> {
        if self.is_closed() {
            return Err(self.closed_error());
        }
        let request_id = format!("req-{}", self.next_request.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = mpsc::channel();
        self.shared
            .pending
            .lock()
            .unwrap()
            .insert(request_id.clone(), tx);
        let request = Request {
            message_type: RequestType::Request,
            request_id: request_id.clone(),
            method: method.to_string(),
            params,
            precondition: None,
        };
        let payload = serde_json::to_vec(&request).map_err(|error| {
            self.shared.pending.lock().unwrap().remove(&request_id);
            RemoteCommandError::new("request_encode_failed", error.to_string())
        })?;
        if let Err(error) = self.writer.lock().unwrap().write_frame(&payload) {
            self.shared.pending.lock().unwrap().remove(&request_id);
            self.close(&error.to_string());
            return Err(RemoteCommandError::new(error.code(), error.to_string()));
        }

        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.shared.pending.lock().unwrap().remove(&request_id);
                return Err(RemoteCommandError::new(
                    "request_timeout",
                    format!("{method} did not complete within {}s", timeout.as_secs()),
                ));
            }
            match rx.recv_timeout(remaining) {
                Ok(PendingReply::Envelope(envelope)) => {
                    match *envelope {
                        ServerEnvelope::Accepted { .. } => continue,
                        ServerEnvelope::Result {
                            status,
                            value,
                            error,
                            ..
                        } => {
                            return match status {
                            ResultStatus::Succeeded => Ok(value.unwrap_or(Value::Null)),
                            ResultStatus::Failed => {
                                let error = error.unwrap_or(agentport_remote_protocol::RemoteError {
                                    code: "remote_failed".to_string(),
                                    message: "remote request failed".to_string(),
                                });
                                Err(RemoteCommandError::new(error.code, error.message))
                            }
                            ResultStatus::NotExecuted => Err(RemoteCommandError::new(
                                "not_executed",
                                error
                                    .map(|e| e.message)
                                    .unwrap_or_else(|| format!("{method} was not executed")),
                            )),
                            ResultStatus::Unknown => Err(RemoteCommandError::new(
                                "unknown_outcome",
                                format!("{method} outcome could not be observed; do not retry blindly"),
                            )),
                        };
                        }
                        _ => {
                            return Err(RemoteCommandError::new(
                                "unexpected_reply",
                                format!("{method} received an unexpected reply frame"),
                            ));
                        }
                    }
                }
                Ok(PendingReply::Closed(reason)) => {
                    return Err(RemoteCommandError::new("transport_closed", reason));
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.shared.pending.lock().unwrap().remove(&request_id);
                    return Err(RemoteCommandError::new(
                        "request_timeout",
                        format!("{method} did not complete within {}s", timeout.as_secs()),
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(self.closed_error());
                }
            }
        }
    }

    /// Registers an event subscriber. The closure returns `false` when its
    /// consumer is gone (e.g. webview reloaded) and is then pruned.
    pub fn subscribe(&self, subscriber: Subscriber) {
        self.shared.subscribers.lock().unwrap().push(subscriber);
    }

    /// Closes the transport and joins the reader thread. Safe to call twice.
    pub fn shutdown(&self) {
        self.writer.lock().unwrap().shutdown();
        self.close("shutdown requested");
        let handle = self.reader_thread.lock().unwrap().take();
        if let Some(handle) = handle {
            if handle.thread().id() != std::thread::current().id() {
                let _ = handle.join();
            }
        }
    }

    fn closed_error(&self) -> RemoteCommandError {
        let reason = self
            .shared
            .close_reason
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "connection is closed".to_string());
        RemoteCommandError::new("transport_closed", reason)
    }
}

impl Drop for RemoteConnection {
    fn drop(&mut self) {
        self.writer.lock().unwrap().shutdown();
        self.close("connection dropped");
    }
}

impl std::fmt::Debug for RemoteConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RemoteConnection")
            .field("closed", &self.is_closed())
            .field("protocol", &self.hello.protocol)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::transport::{SocketFrameReader, UnixStreamFrameWriter};

    fn hello_result() -> agentport_remote_protocol::HelloResult {
        agentport_remote_protocol::HelloResult {
            protocol: ProtocolVersion::V1,
            server: agentport_remote_protocol::ServerIdentity {
                agentport_version: "0.0.0-test".to_string(),
                platform: "test".to_string(),
            },
            capabilities: vec![],
            limits: agentport_remote_protocol::Limits {
                max_frame_bytes: agentport_remote_protocol::MAX_FRAME_BYTES,
                max_subscriptions: 8,
                max_host_clients: 8,
            },
        }
    }

    fn identity() -> ClientIdentity {
        ClientIdentity {
            name: "agentport-desktop-test".to_string(),
            version: "0.0.0".to_string(),
        }
    }

    /// Starts an in-process fake bridge speaking one scripted exchange.
    fn spawn_fake_bridge<F>(script: F) -> (std::os::unix::net::UnixStream, JoinHandle<()>)
    where
        F: FnOnce(
                std::os::unix::net::UnixStream,
            ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
            + Send
            + 'static,
    {
        let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
        let handle = std::thread::spawn(move || {
            let _ = script(server);
        });
        (client, handle)
    }

    fn write_envelope(
        stream: &mut std::os::unix::net::UnixStream,
        envelope: &ServerEnvelope,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use std::io::Write;
        let payload = serde_json::to_vec(envelope)?;
        let frame = crate::remote::transport::encode_frame(&payload)?;
        stream.write_all(&frame)?;
        stream.flush()?;
        Ok(())
    }

    fn read_request(
        stream: &mut std::os::unix::net::UnixStream,
    ) -> Result<Request, Box<dyn std::error::Error + Send + Sync>> {
        let frame = agentport_remote_protocol::read_frame(
            stream,
            agentport_remote_protocol::MAX_FRAME_BYTES,
        )?
        .expect("request frame");
        Ok(serde_json::from_slice(frame.as_bytes())?)
    }

    fn establish_over(
        stream: std::os::unix::net::UnixStream,
    ) -> Result<Arc<RemoteConnection>, RemoteCommandError> {
        let reader = SocketFrameReader::new(stream.try_clone().unwrap());
        let writer = UnixStreamFrameWriter::new(stream);
        RemoteConnection::establish(Box::new(reader), Box::new(writer), identity())
    }

    #[test]
    fn handshake_then_request_round_trip() {
        let (client, _server_thread) = spawn_fake_bridge(|mut server| {
            let _hello: serde_json::Value = serde_json::from_slice(
                agentport_remote_protocol::read_frame(
                    &mut server,
                    agentport_remote_protocol::MAX_FRAME_BYTES,
                )?
                .expect("hello frame")
                .as_bytes(),
            )?;
            write_envelope(&mut server, &ServerEnvelope::Hello(hello_result()))?;
            let request = read_request(&mut server)?;
            assert_eq!(request.method, "session.list");
            write_envelope(
                &mut server,
                &ServerEnvelope::Result {
                    request_id: request.request_id,
                    operation_id: None,
                    status: ResultStatus::Succeeded,
                    retry_class: agentport_remote_protocol::RetryClass::Read,
                    value: Some(serde_json::json!({"sessions": []})),
                    error: None,
                },
            )?;
            Ok(())
        });
        let connection = establish_over(client).unwrap();
        let value = connection
            .request(
                "session.list",
                serde_json::json!({}),
                Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(value, serde_json::json!({"sessions": []}));
        connection.shutdown();
    }

    #[test]
    fn failed_result_maps_remote_error_code() {
        let (client, _server_thread) = spawn_fake_bridge(|mut server| {
            agentport_remote_protocol::read_frame(
                &mut server,
                agentport_remote_protocol::MAX_FRAME_BYTES,
            )?;
            write_envelope(&mut server, &ServerEnvelope::Hello(hello_result()))?;
            let request = read_request(&mut server)?;
            write_envelope(
                &mut server,
                &ServerEnvelope::Result {
                    request_id: request.request_id,
                    operation_id: None,
                    status: ResultStatus::Failed,
                    retry_class: agentport_remote_protocol::RetryClass::Read,
                    value: None,
                    error: Some(agentport_remote_protocol::RemoteError {
                        code: "session_not_found".to_string(),
                        message: "no such session".to_string(),
                    }),
                },
            )?;
            Ok(())
        });
        let connection = establish_over(client).unwrap();
        let error = connection
            .request(
                "session.attach",
                serde_json::json!({"sessionId": "ses_x"}),
                Duration::from_secs(5),
            )
            .unwrap_err();
        assert_eq!(error.code, "session_not_found");
        connection.shutdown();
    }

    #[test]
    fn accepted_is_consumed_until_result() {
        let (client, _server_thread) = spawn_fake_bridge(|mut server| {
            agentport_remote_protocol::read_frame(
                &mut server,
                agentport_remote_protocol::MAX_FRAME_BYTES,
            )?;
            write_envelope(&mut server, &ServerEnvelope::Hello(hello_result()))?;
            let request = read_request(&mut server)?;
            write_envelope(
                &mut server,
                &ServerEnvelope::Accepted {
                    request_id: request.request_id.clone(),
                    operation_id: "op-1".to_string(),
                    server_sequence: 1,
                    retry_class: agentport_remote_protocol::RetryClass::NonIdempotentWrite,
                },
            )?;
            write_envelope(
                &mut server,
                &ServerEnvelope::Result {
                    request_id: request.request_id,
                    operation_id: Some("op-1".to_string()),
                    status: ResultStatus::Succeeded,
                    retry_class: agentport_remote_protocol::RetryClass::NonIdempotentWrite,
                    value: Some(serde_json::json!({"ok": true})),
                    error: None,
                },
            )?;
            Ok(())
        });
        let connection = establish_over(client).unwrap();
        let value = connection
            .request(
                "session.stop",
                serde_json::json!({"sessionId": "ses_x"}),
                Duration::from_secs(5),
            )
            .unwrap();
        assert_eq!(value, serde_json::json!({"ok": true}));
        connection.shutdown();
    }

    #[test]
    fn events_fan_out_to_subscribers_and_close_notifies() {
        let (client, _server_thread) = spawn_fake_bridge(|mut server| {
            agentport_remote_protocol::read_frame(
                &mut server,
                agentport_remote_protocol::MAX_FRAME_BYTES,
            )?;
            write_envelope(&mut server, &ServerEnvelope::Hello(hello_result()))?;
            let cursor = agentport_remote_protocol::RunCursor {
                run_id: "run-1".to_string(),
                run_ordinal: 1,
                generation: 1,
                offset: 42,
                status_sequence: 3,
            };
            write_envelope(
                &mut server,
                &ServerEnvelope::Event(agentport_remote_protocol::Event {
                    subscription_id: "sub-1".to_string(),
                    event_type: "output".to_string(),
                    cursor,
                    payload: serde_json::json!({"bytes": "aGk="}),
                }),
            )?;
            // Keep the transport open briefly so the client can observe the
            // event, then close to trigger transport_closed.
            std::thread::sleep(Duration::from_millis(200));
            Ok(())
        });
        let connection = establish_over(client).unwrap();
        let (tx, rx) = mpsc::channel();
        connection.subscribe(Arc::new(move |msg| {
            tx.send((
                msg.subscription_id.clone(),
                msg.event_type.clone(),
                msg.cursor.clone(),
            ))
            .is_ok()
        }));
        let first = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first.0, "sub-1");
        assert_eq!(first.1, "output");
        assert!(first.2.is_some());
        let closed = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(closed.1, "transport_closed");
        assert!(closed.2.is_none(), "control events carry no cursor");
        assert!(connection.is_closed());
        connection.shutdown();
    }

    #[test]
    fn request_times_out_with_distinct_code() {
        let (client, server_thread) = spawn_fake_bridge(|mut server| {
            agentport_remote_protocol::read_frame(
                &mut server,
                agentport_remote_protocol::MAX_FRAME_BYTES,
            )?;
            write_envelope(&mut server, &ServerEnvelope::Hello(hello_result()))?;
            // Read the request but never answer it.
            let _ = read_request(&mut server)?;
            std::thread::sleep(Duration::from_millis(600));
            Ok(())
        });
        let connection = establish_over(client).unwrap();
        let error = connection
            .request(
                "session.list",
                serde_json::json!({}),
                Duration::from_millis(200),
            )
            .unwrap_err();
        assert_eq!(error.code, "request_timeout");
        connection.shutdown();
        let _ = server_thread.join();
    }

    #[test]
    fn incompatible_hello_is_rejected() {
        let (client, _server_thread) = spawn_fake_bridge(|mut server| {
            agentport_remote_protocol::read_frame(
                &mut server,
                agentport_remote_protocol::MAX_FRAME_BYTES,
            )?;
            write_envelope(
                &mut server,
                &ServerEnvelope::Incompatible {
                    supported: ProtocolVersion { major: 2, minor: 0 },
                    message: "upgrade required".to_string(),
                },
            )?;
            Ok(())
        });
        let error = establish_over(client).unwrap_err();
        assert_eq!(error.code, "protocol_incompatible");
    }
}
