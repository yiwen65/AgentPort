//! Connection manager: one explicit connection lifecycle per remote device.
//!
//! The manager is AppHandle-free managed state. Device connection info comes
//! from a `DeviceResolver` — T-003 replaces `NullResolver` with the real
//! device registry + credential store without touching this module.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant};

use agentport_core::paths::AppPaths;
use agentport_relay::crypto::Identity;
use agentport_relay::protocol::Peer;
use agentport_remote_protocol::ClientIdentity;
use sha2::{Digest, Sha256};

use crate::remote::connection::RemoteConnection;
use crate::remote::identity::ClientIdentityStore;
use crate::remote::ssh::{self, SshSecret, SshTarget};
use crate::remote::tofu::TofuStore;
use crate::remote::types::DeviceProfile;
use crate::remote::{relay, RemoteCommandError, RemoteHello};

pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// One image upload request may cross a WAN; every frame gets this bound.
const IMAGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Whole-transfer budget for one image paste (all chunks + finish).
const IMAGE_UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);
/// Bound on queued-but-unsent terminal input frames per device. Each frame is
/// at most one xterm input event (keystroke/wheel report), so this only fills
/// while the link is far behind a paste or a fast scroll.
const INPUT_QUEUE_CAPACITY: usize = 1024;

/// One ordered terminal-input frame waiting for the per-device writer.
struct InputJob {
    method: String,
    params: serde_json::Value,
}

/// How to reach a device.
#[derive(Debug, Clone)]
#[allow(dead_code)] // consumed by the T-003 registry resolver
pub enum DeviceTransport {
    Ssh(SshTarget),
    Relay(Peer),
}

/// Everything needed to open one connection, secret material included.
#[derive(Debug)]
#[allow(dead_code)] // device_id/secret are filled by the T-003 registry resolver
pub struct DeviceConnectionInfo {
    pub device_id: String,
    pub display_name: Option<String>,
    pub transport: DeviceTransport,
    pub secret: Option<SshSecret>,
}

/// Resolves a device id to connection info. Implemented by the device
/// registry (T-003); the null resolver keeps T-001 commands structurally
/// complete and yields `device_not_found` for every id.
pub trait DeviceResolver: Send + Sync {
    fn resolve(&self, device_id: &str) -> Result<DeviceConnectionInfo, RemoteCommandError>;
    /// Records a dial outcome so the registry can maintain
    /// `last_connected_at`/`last_error`. Default no-op (null resolver, test
    /// fixtures); the device registry overrides it.
    fn record_connect_outcome(&self, _device_id: &str, _error: Option<&RemoteCommandError>) {}
}

/// Result of a successful SSH device probe (connect + hello + shutdown).
pub struct SshProbeOutcome {
    #[allow(dead_code)] // consumed by tests; future UI surfacing of server info
    pub server_platform: String,
    #[allow(dead_code)] // consumed by tests; future UI surfacing of server info
    pub server_agentport_version: String,
}

/// Probe-first onboarding seam: `device_add_ssh` proves reachability and
/// protocol compatibility through this trait, so tests inject fakes instead
/// of a network.
pub trait SshProber: Send + Sync {
    fn probe(
        &self,
        target: &SshTarget,
        secret: &SshSecret,
    ) -> Result<SshProbeOutcome, RemoteCommandError>;
}

/// Production prober: real SSH connect, full hello handshake, clean shutdown.
struct LiveSshProber {
    tofu: Arc<Mutex<TofuStore>>,
    client_identity: ClientIdentity,
    timeout: Duration,
}

impl SshProber for LiveSshProber {
    fn probe(
        &self,
        target: &SshTarget,
        secret: &SshSecret,
    ) -> Result<SshProbeOutcome, RemoteCommandError> {
        let (reader, writer) = ssh::connect(target, secret, Arc::clone(&self.tofu), self.timeout)
            .map_err(map_probe_error)?;
        let connection = RemoteConnection::establish(reader, writer, self.client_identity.clone())
            .map_err(map_probe_error)?;
        let hello = connection.hello().clone();
        connection.shutdown();
        Ok(SshProbeOutcome {
            server_platform: hello.server.platform.clone(),
            server_agentport_version: hello.server.agentport_version.clone(),
        })
    }
}

/// Maps transport/handshake failures onto the distinct add-device error
/// family the frontend branches on; already-distinct codes
/// (`host_key_changed`, `protocol_incompatible`, tofu/relay failures) pass
/// through unchanged.
fn map_probe_error(error: RemoteCommandError) -> RemoteCommandError {
    let code = match error.code.as_str() {
        "ssh_connect_failed"
        | "ssh_connect_timeout"
        | "ssh_runtime_failed"
        | "ssh_thread_failed" => "device_unreachable",
        "ssh_auth_failed" | "ssh_key_invalid" => "auth_failed",
        "bridge_start_failed" => "bridge_missing",
        other => other,
    };
    RemoteCommandError::new(code, error.message)
}

#[derive(Default)]
pub struct NullResolver;

impl DeviceResolver for NullResolver {
    fn resolve(&self, device_id: &str) -> Result<DeviceConnectionInfo, RemoteCommandError> {
        Err(RemoteCommandError::new(
            "device_not_found",
            format!("no device registered as {device_id}"),
        ))
    }
}

struct ConnectionSlot {
    connection: Arc<RemoteConnection>,
    hello: RemoteHello,
}

pub struct RemoteConnectionManager {
    // Used by tests now; T-002 also derives identity paths from it.
    #[allow(dead_code)]
    paths: AppPaths,
    tofu: Arc<Mutex<TofuStore>>,
    identity_store: ClientIdentityStore,
    resolver: RwLock<Arc<dyn DeviceResolver>>,
    prober: RwLock<Arc<dyn SshProber>>,
    connections: Mutex<HashMap<String, ConnectionSlot>>,
    /// Per-device ordered terminal-input writers. Exactly one worker thread
    /// per device owns the input frames, so callers can enqueue immediately
    /// instead of waiting one round trip per keystroke/wheel report.
    input_queues: Mutex<HashMap<String, mpsc::SyncSender<InputJob>>>,
    /// Connect dedupe: the first caller per device leads, followers wait.
    connecting: Mutex<HashSet<String>>,
    connecting_cv: Condvar,
    /// Per-device connect fences. Disconnect bumps the epoch so a dial that
    /// finishes later cannot publish a connection slot.
    connect_epochs: Mutex<HashMap<String, Arc<AtomicU64>>>,
    client_identity: ClientIdentity,
}

impl RemoteConnectionManager {
    pub fn new(paths: &AppPaths) -> Result<Self, RemoteCommandError> {
        let devices = paths.root().join("devices");
        let tofu = Arc::new(Mutex::new(TofuStore::load(
            devices.join("known-hosts.json"),
        )?));
        let client_identity = ClientIdentity {
            name: "agentport-desktop".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let prober: Arc<dyn SshProber> = Arc::new(LiveSshProber {
            tofu: Arc::clone(&tofu),
            client_identity: client_identity.clone(),
            timeout: SSH_CONNECT_TIMEOUT,
        });
        Ok(Self {
            paths: paths.clone(),
            tofu,
            identity_store: ClientIdentityStore::new(devices.join("identity.json")),
            resolver: RwLock::new(Arc::new(NullResolver)),
            prober: RwLock::new(prober),
            connections: Mutex::new(HashMap::new()),
            input_queues: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashSet::new()),
            connecting_cv: Condvar::new(),
            connect_epochs: Mutex::new(HashMap::new()),
            client_identity,
        })
    }

    /// Swaps the device resolver (T-003 registry drops in here).
    pub fn set_resolver(&self, resolver: Arc<dyn DeviceResolver>) {
        *self.resolver.write().unwrap() = resolver;
    }

    fn connect_epoch(&self, device_id: &str) -> Arc<AtomicU64> {
        self.connect_epochs
            .lock()
            .unwrap()
            .entry(device_id.to_string())
            .or_insert_with(|| Arc::new(AtomicU64::new(0)))
            .clone()
    }

    /// The prober `device_add_ssh` onboards through (live SSH by default).
    pub fn ssh_prober(&self) -> Arc<dyn SshProber> {
        Arc::clone(&self.prober.read().unwrap())
    }

    #[cfg(test)]
    pub fn set_prober(&self, prober: Arc<dyn SshProber>) {
        *self.prober.write().unwrap() = prober;
    }

    /// This installation's client relay identity (load-or-generate, durable).
    pub fn identity(&self) -> Result<Arc<Identity>, RemoteCommandError> {
        self.identity_store.identity()
    }

    /// Redeems a pairing payload against the controlled PC. The returned
    /// profile is NOT persisted — the device registry (T-003) owns that.
    pub async fn redeem_pairing(
        &self,
        payload: &str,
        name: Option<String>,
    ) -> Result<DeviceProfile, RemoteCommandError> {
        let identity = self.identity()?;
        crate::remote::pairing::redeem_pairing(identity.as_ref(), payload, name).await
    }

    #[allow(dead_code)] // surfaced to the frontend by a later task
    pub fn is_connected(&self, device_id: &str) -> bool {
        self.connections
            .lock()
            .unwrap()
            .get(device_id)
            .is_some_and(|slot| !slot.connection.is_closed())
    }

    /// Connects (or reuses a live connection) and returns the negotiated
    /// Hello summary. Concurrent callers for the same device coalesce.
    pub fn connect(&self, device_id: &str) -> Result<RemoteHello, RemoteCommandError> {
        // Fast path: a live connection already exists.
        if let Some(slot) = self.connections.lock().unwrap().get(device_id) {
            if !slot.connection.is_closed() {
                return Ok(slot.hello.clone());
            }
        }
        // Leadership election so parallel connects do not double-dial.
        let mut connecting = self.connecting.lock().unwrap();
        loop {
            if let Some(slot) = self.connections.lock().unwrap().get(device_id) {
                if !slot.connection.is_closed() {
                    return Ok(slot.hello.clone());
                }
            }
            if connecting.insert(device_id.to_string()) {
                break;
            }
            connecting = self.connecting_cv.wait(connecting).unwrap();
        }
        drop(connecting);

        let result = self.connect_leading(device_id);

        let mut connecting = self.connecting.lock().unwrap();
        connecting.remove(device_id);
        self.connecting_cv.notify_all();
        result
    }

    fn connect_leading(&self, device_id: &str) -> Result<RemoteHello, RemoteCommandError> {
        // Drop any half-dead slot (and its input writer) before dialing again.
        self.drop_input_queue(device_id);
        if let Some(stale) = self.connections.lock().unwrap().remove(device_id) {
            stale.connection.shutdown();
        }
        let epoch = self.connect_epoch(device_id);
        let epoch_started = epoch.load(Ordering::SeqCst);
        let info = self.resolver.read().unwrap().resolve(device_id)?;
        let attempt = self.dial(device_id, &info);
        self.resolver
            .read()
            .unwrap()
            .record_connect_outcome(device_id, attempt.as_ref().err());
        let (connection, hello) = attempt?;
        let mut connections = self.connections.lock().unwrap();
        connections.insert(
            device_id.to_string(),
            ConnectionSlot {
                connection,
                hello: hello.clone(),
            },
        );
        if epoch.load(Ordering::SeqCst) != epoch_started {
            if let Some(slot) = connections.remove(device_id) {
                slot.connection.shutdown();
            }
            drop(connections);
            return Err(RemoteCommandError::new(
                "connect_cancelled",
                "the device was disconnected while connecting",
            ));
        }
        Ok(hello)
    }

    /// Dials and handshakes without touching the connection map, so the
    /// outcome can be recorded before the slot is published.
    fn dial(
        &self,
        device_id: &str,
        info: &DeviceConnectionInfo,
    ) -> Result<(Arc<RemoteConnection>, RemoteHello), RemoteCommandError> {
        let (reader, writer) = match &info.transport {
            DeviceTransport::Ssh(target) => {
                let secret = info.secret.as_ref().ok_or_else(|| {
                    RemoteCommandError::new(
                        "credential_missing",
                        format!("no stored credential for {device_id}"),
                    )
                })?;
                ssh::connect(target, secret, Arc::clone(&self.tofu), SSH_CONNECT_TIMEOUT)?
            }
            DeviceTransport::Relay(peer) => {
                let identity = self.identity()?;
                relay::connect(peer, identity, RELAY_CONNECT_TIMEOUT)?
            }
        };
        let connection = RemoteConnection::establish(reader, writer, self.client_identity.clone())?;
        let hello = RemoteHello::from_hello_result(
            connection.hello(),
            info.display_name
                .clone()
                .unwrap_or_else(|| device_id.to_string()),
        );
        Ok((connection, hello))
    }

    /// Sends one request on a live connection.
    pub fn request(
        &self,
        device_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, RemoteCommandError> {
        let connection = self.connection_for(device_id)?;
        connection.request(method, params, DEFAULT_REQUEST_TIMEOUT)
    }

    /// Uploads one PNG/JPEG image to the remote device and returns its
    /// absolute path there. A remote TUI cannot read this machine's
    /// clipboard, so the renderer inserts the returned path instead of
    /// forwarding Ctrl+V. Failures abort the in-progress upload.
    pub fn upload_image(
        &self,
        device_id: &str,
        bytes: &[u8],
    ) -> Result<String, RemoteCommandError> {
        use agentport_remote_protocol::image::MAX_IMAGE_BYTES;

        let size = bytes.len() as u64;
        if size == 0 || size > MAX_IMAGE_BYTES {
            return Err(RemoteCommandError::new(
                "image_invalid",
                "Images must be between 1 byte and 20 MiB.",
            ));
        }
        let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            "png"
        } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
            "jpg"
        } else {
            return Err(RemoteCommandError::new(
                "image_invalid",
                "Only PNG and JPEG images can be pasted into a remote session.",
            ));
        };
        let connection = self.connection_for(device_id)?;
        let capable = connection.hello().capabilities.iter().any(|capability| {
            capability.name == agentport_remote_protocol::image::CAPABILITY && capability.enabled
        });
        if !capable {
            return Err(RemoteCommandError::new(
                "image_upload_unavailable",
                "The remote device does not support image paste; update AgentPort there.",
            ));
        }

        let begin = connection.request(
            "image.begin",
            serde_json::json!({"size": size, "extension": extension}),
            IMAGE_REQUEST_TIMEOUT,
        )?;
        let upload_id = begin["uploadId"]
            .as_str()
            .ok_or_else(|| {
                RemoteCommandError::new(
                    "image_upload_failed",
                    "The remote device did not return an image upload identifier.",
                )
            })?
            .to_string();
        let result = stream_image(&connection, &upload_id, bytes);
        if result.is_err() {
            let _ = connection.request(
                "image.abort",
                serde_json::json!({"uploadId": upload_id}),
                Duration::from_secs(5),
            );
        }
        result
    }

    /// Enqueues one terminal-input frame for ordered, ack-independent
    /// delivery. Returns as soon as the frame is queued; a per-device worker
    /// writes frames in call order, so a wheel/keystroke burst is not
    /// serialized behind one round trip per event. The bridge answers each
    /// frame normally; the reader discards results without a waiter.
    pub fn enqueue_input(
        &self,
        device_id: &str,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), RemoteCommandError> {
        let sender = self.input_sender(device_id)?;
        match sender.try_send(InputJob {
            method: method.to_string(),
            params,
        }) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => Err(RemoteCommandError::new(
                "input_queue_full",
                format!("too many terminal input frames are queued for {device_id}"),
            )),
            Err(mpsc::TrySendError::Disconnected(_)) => {
                self.drop_input_queue(device_id);
                Err(RemoteCommandError::new(
                    "not_connected",
                    format!("input writer for {device_id} is gone; reconnect required"),
                ))
            }
        }
    }

    fn input_sender(
        &self,
        device_id: &str,
    ) -> Result<mpsc::SyncSender<InputJob>, RemoteCommandError> {
        if let Some(sender) = self.input_queues.lock().unwrap().get(device_id).cloned() {
            return Ok(sender);
        }
        // Resolve the connection before retaking the queue lock so the
        // connections/input_queues locks are never held in opposite order.
        let connection = self.connection_for(device_id)?;
        let (sender, receiver) = mpsc::sync_channel::<InputJob>(INPUT_QUEUE_CAPACITY);
        std::thread::Builder::new()
            .name("agentport-remote-input".into())
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    if let Err(error) = connection.submit(&job.method, job.params) {
                        tracing::warn!(
                            code = %error.code,
                            message = %error.message,
                            "remote: ordered input writer stopped"
                        );
                        break;
                    }
                }
            })
            .map_err(|error| RemoteCommandError::new("input_worker_failed", error.to_string()))?;
        let mut queues = self.input_queues.lock().unwrap();
        // A concurrent caller may have created the worker first; only one
        // worker may write, so keep the existing sender and let ours exit.
        if let Some(existing) = queues.get(device_id) {
            return Ok(existing.clone());
        }
        queues.insert(device_id.to_string(), sender.clone());
        Ok(sender)
    }

    fn drop_input_queue(&self, device_id: &str) {
        self.input_queues.lock().unwrap().remove(device_id);
    }

    /// Registers an event subscriber on a live connection.
    pub fn subscribe(
        &self,
        device_id: &str,
        subscriber: crate::remote::connection::Subscriber,
    ) -> Result<(), RemoteCommandError> {
        let connection = self.connection_for(device_id)?;
        connection.subscribe(subscriber);
        Ok(())
    }

    pub fn disconnect(&self, device_id: &str) {
        self.connect_epoch(device_id).fetch_add(1, Ordering::SeqCst);
        self.drop_input_queue(device_id);
        if let Some(slot) = self.connections.lock().unwrap().remove(device_id) {
            slot.connection.shutdown();
        }
    }

    /// Disconnects every device (app teardown / test cleanup).
    pub fn disconnect_all(&self) {
        for epoch in self.connect_epochs.lock().unwrap().values() {
            epoch.fetch_add(1, Ordering::SeqCst);
        }
        self.input_queues.lock().unwrap().clear();
        let slots: Vec<ConnectionSlot> = self
            .connections
            .lock()
            .unwrap()
            .drain()
            .map(|(_, slot)| slot)
            .collect();
        for slot in slots {
            slot.connection.shutdown();
        }
    }

    fn connection_for(&self, device_id: &str) -> Result<Arc<RemoteConnection>, RemoteCommandError> {
        let mut connections = self.connections.lock().unwrap();
        match connections.get(device_id) {
            Some(slot) if !slot.connection.is_closed() => Ok(Arc::clone(&slot.connection)),
            Some(_) => {
                if let Some(slot) = connections.remove(device_id) {
                    drop(connections);
                    slot.connection.shutdown();
                }
                Err(RemoteCommandError::new(
                    "transport_closed",
                    format!("connection to {device_id} is closed; reconnect required"),
                ))
            }
            None => Err(RemoteCommandError::new(
                "not_connected",
                format!("device {device_id} is not connected"),
            )),
        }
    }

    #[cfg(test)]
    pub fn connect_with_transport(
        &self,
        device_id: &str,
        display_name: Option<String>,
        reader: Box<dyn crate::remote::transport::FrameReader>,
        writer: Box<dyn crate::remote::transport::FrameWriter>,
    ) -> Result<RemoteHello, RemoteCommandError> {
        self.drop_input_queue(device_id);
        if let Some(stale) = self.connections.lock().unwrap().remove(device_id) {
            stale.connection.shutdown();
        }
        let connection = RemoteConnection::establish(reader, writer, self.client_identity.clone())?;
        let hello = RemoteHello::from_hello_result(
            connection.hello(),
            display_name.unwrap_or_else(|| device_id.to_string()),
        );
        self.connections.lock().unwrap().insert(
            device_id.to_string(),
            ConnectionSlot {
                connection,
                hello: hello.clone(),
            },
        );
        Ok(hello)
    }
}

/// Streams the image body in bounded binary chunks and finishes the upload
/// with a SHA-256 digest. Each chunk is acknowledged before the next frame so
/// a slow link keeps terminal requests interleaved instead of queuing the
/// whole image ahead of them.
fn stream_image(
    connection: &RemoteConnection,
    upload_id: &str,
    bytes: &[u8],
) -> Result<String, RemoteCommandError> {
    use agentport_remote_protocol::image::MAX_CHUNK_BYTES;

    let started = Instant::now();
    let mut offset = 0usize;
    let mut digest = Sha256::new();
    while offset < bytes.len() {
        if started.elapsed() > IMAGE_UPLOAD_TIMEOUT {
            return Err(RemoteCommandError::new(
                "image_upload_timeout",
                "The image upload timed out. Please try again.",
            ));
        }
        let end = (offset + MAX_CHUNK_BYTES).min(bytes.len());
        let chunk = &bytes[offset..end];
        let ack = connection.request_binary(
            "image.chunk",
            serde_json::json!({"uploadId": upload_id, "offset": offset}),
            chunk,
            IMAGE_REQUEST_TIMEOUT,
        )?;
        if ack["offset"].as_u64() != Some(end as u64) {
            return Err(RemoteCommandError::new(
                "image_upload_failed",
                "The remote device did not acknowledge the image bytes.",
            ));
        }
        digest.update(chunk);
        offset = end;
    }
    let finish = connection.request(
        "image.finish",
        serde_json::json!({
            "uploadId": upload_id,
            "sha256": format!("{:x}", digest.finalize()),
        }),
        IMAGE_REQUEST_TIMEOUT,
    )?;
    finish["path"]
        .as_str()
        .filter(|path| path.starts_with('/'))
        .map(str::to_string)
        .ok_or_else(|| {
            RemoteCommandError::new(
                "image_upload_failed",
                "The remote device returned an invalid image path.",
            )
        })
}

impl Drop for RemoteConnectionManager {
    fn drop(&mut self) {
        self.disconnect_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_resolver_reports_device_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let manager =
            RemoteConnectionManager::new(&AppPaths::new(dir.path().to_path_buf())).unwrap();
        let error = manager.connect("dev_missing").unwrap_err();
        assert_eq!(error.code, "device_not_found");
    }

    #[test]
    fn request_before_connect_is_not_connected() {
        let dir = tempfile::tempdir().unwrap();
        let manager =
            RemoteConnectionManager::new(&AppPaths::new(dir.path().to_path_buf())).unwrap();
        let error = manager
            .request("dev_missing", "session.list", serde_json::json!({}))
            .unwrap_err();
        assert_eq!(error.code, "not_connected");
    }

    /// Loopback integration: a real in-process bridge (`CoreService` on an
    /// isolated data root) speaks the protocol with the manager over a Unix
    /// socket pair — no network, no sshd, no env mutation.
    #[test]
    fn loopback_hello_and_requests_against_real_bridge() {
        use crate::remote::transport::{SocketFrameReader, UnixStreamFrameWriter};
        use agentport_remote_protocol::ProtocolVersion;

        let dir = tempfile::tempdir().unwrap();
        let service =
            agentport_service::CoreService::open(AppPaths::new(dir.path().join("remote-root")))
                .unwrap();
        let (client, server) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut server_reader = server.try_clone().unwrap();
        let mut server_writer = server;
        let bridge = std::thread::spawn(move || {
            let mut diagnostics = Vec::new();
            agentport_remote_bridge::serve(
                &mut server_reader,
                &mut server_writer,
                &mut diagnostics,
                &service,
            )
        });

        let manager =
            RemoteConnectionManager::new(&AppPaths::new(dir.path().join("local-root"))).unwrap();
        let reader = SocketFrameReader::new(client.try_clone().unwrap());
        let writer = UnixStreamFrameWriter::new(client);
        let hello = manager
            .connect_with_transport(
                "dev_loop",
                Some("loopback".to_string()),
                Box::new(reader),
                Box::new(writer),
            )
            .unwrap();
        assert_eq!(hello.protocol_version, ProtocolVersion::V1);
        assert_eq!(hello.device_name, "loopback");
        assert!(
            hello
                .capabilities
                .iter()
                .any(|name| name == agentport_remote_protocol::CAPABILITY_SESSION_EVENT_PUSH),
            "bridge must grant the requested event-push capability: {:?}",
            hello.capabilities
        );

        let sessions = manager
            .request("dev_loop", "session.list", serde_json::json!({}))
            .unwrap();
        assert_eq!(sessions, serde_json::json!([]));
        let projects = manager
            .request("dev_loop", "project.list", serde_json::json!({}))
            .unwrap();
        assert_eq!(projects, serde_json::json!([]));

        let error = manager
            .request("dev_loop", "no.such.method", serde_json::json!({}))
            .unwrap_err();
        assert!(
            !error.code.is_empty() && error.code != "transport_closed",
            "unknown method must fail with a structured remote error, got {error:?}"
        );

        manager.disconnect("dev_loop");
        drop(manager);
        let close = bridge.join().unwrap().unwrap();
        assert_eq!(close, agentport_remote_bridge::CloseReason::EndOfInput);
    }

    fn fake_hello(
        capabilities: Vec<agentport_remote_protocol::Capability>,
    ) -> agentport_remote_protocol::HelloResult {
        agentport_remote_protocol::HelloResult {
            protocol: agentport_remote_protocol::ProtocolVersion::V1,
            server: agentport_remote_protocol::ServerIdentity {
                agentport_version: "0.0.0-test".to_string(),
                platform: "test".to_string(),
            },
            capabilities,
            limits: agentport_remote_protocol::Limits {
                max_frame_bytes: agentport_remote_protocol::MAX_FRAME_BYTES,
                max_subscriptions: 8,
                max_host_clients: 8,
            },
        }
    }

    fn write_envelope(
        stream: &mut std::os::unix::net::UnixStream,
        envelope: &agentport_remote_protocol::ServerEnvelope,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use std::io::Write;
        let payload = serde_json::to_vec(envelope)?;
        let frame = crate::remote::transport::encode_frame(&payload)?;
        stream.write_all(&frame)?;
        stream.flush()?;
        Ok(())
    }

    fn read_frame_bytes(
        stream: &mut std::os::unix::net::UnixStream,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error + Send + Sync>> {
        Ok(agentport_remote_protocol::read_frame(
            stream,
            agentport_remote_protocol::MAX_FRAME_BYTES,
        )?
        .expect("frame")
        .as_bytes()
        .to_vec())
    }

    fn reply_succeeded(
        stream: &mut std::os::unix::net::UnixStream,
        request_id: &str,
        value: serde_json::Value,
        retry_class: agentport_remote_protocol::RetryClass,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        write_envelope(
            stream,
            &agentport_remote_protocol::ServerEnvelope::Result {
                request_id: request_id.to_string(),
                operation_id: None,
                status: agentport_remote_protocol::ResultStatus::Succeeded,
                retry_class,
                value: Some(value),
                error: None,
            },
        )
    }

    #[test]
    fn upload_image_streams_chunks_and_returns_the_remote_path() {
        use crate::remote::transport::{SocketFrameReader, UnixStreamFrameWriter};
        use agentport_remote_protocol::image::{CAPABILITY, MAX_CHUNK_BYTES};
        use agentport_remote_protocol::RetryClass;

        let dir = tempfile::tempdir().unwrap();
        let manager =
            RemoteConnectionManager::new(&AppPaths::new(dir.path().to_path_buf())).unwrap();
        let (client, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut image = vec![0_u8; MAX_CHUNK_BYTES + 10];
        image[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let expected = image.clone();
        let bridge = std::thread::spawn(move || {
            let _hello = read_frame_bytes(&mut server).unwrap();
            write_envelope(
                &mut server,
                &agentport_remote_protocol::ServerEnvelope::Hello(fake_hello(vec![
                    agentport_remote_protocol::Capability {
                        name: CAPABILITY.into(),
                        enabled: true,
                        disabled_reason: None,
                    },
                ])),
            )
            .unwrap();

            let begin: agentport_remote_protocol::Request =
                serde_json::from_slice(&read_frame_bytes(&mut server).unwrap()).unwrap();
            assert_eq!(begin.method, "image.begin");
            assert_eq!(begin.params["size"], expected.len());
            assert_eq!(begin.params["extension"], "png");
            reply_succeeded(
                &mut server,
                &begin.request_id,
                serde_json::json!({"uploadId": "upload-1"}),
                RetryClass::NonIdempotentWrite,
            )
            .unwrap();

            let mut received = Vec::new();
            for expected_offset in [0_usize, MAX_CHUNK_BYTES] {
                let frame = read_frame_bytes(&mut server).unwrap();
                let (header, bytes) =
                    agentport_remote_protocol::image::decode_chunk(&frame).unwrap();
                let chunk: agentport_remote_protocol::Request =
                    serde_json::from_slice(header).unwrap();
                assert_eq!(chunk.method, "image.chunk");
                assert_eq!(chunk.params["uploadId"], "upload-1");
                assert_eq!(chunk.params["offset"], expected_offset);
                received.extend_from_slice(bytes);
                reply_succeeded(
                    &mut server,
                    &chunk.request_id,
                    serde_json::json!({"offset": received.len()}),
                    RetryClass::NonIdempotentWrite,
                )
                .unwrap();
            }
            assert_eq!(received, expected);

            let finish: agentport_remote_protocol::Request =
                serde_json::from_slice(&read_frame_bytes(&mut server).unwrap()).unwrap();
            assert_eq!(finish.method, "image.finish");
            assert_eq!(
                finish.params["sha256"],
                format!("{:x}", Sha256::digest(&expected))
            );
            reply_succeeded(
                &mut server,
                &finish.request_id,
                serde_json::json!({"path": "/home/u/.cache/agentport/image-1.png"}),
                RetryClass::NonIdempotentWrite,
            )
            .unwrap();
            // Keep the connection readable until the manager disconnects.
            while let Ok(Some(_)) = agentport_remote_protocol::read_frame(
                &mut server,
                agentport_remote_protocol::MAX_FRAME_BYTES,
            ) {}
        });

        manager
            .connect_with_transport(
                "dev_img",
                None,
                Box::new(SocketFrameReader::new(client.try_clone().unwrap())),
                Box::new(UnixStreamFrameWriter::new(client)),
            )
            .unwrap();
        let path = manager.upload_image("dev_img", &image).unwrap();
        assert_eq!(path, "/home/u/.cache/agentport/image-1.png");
        manager.disconnect("dev_img");
        drop(manager);
        bridge.join().unwrap();
    }

    #[test]
    fn upload_image_requires_the_negotiated_capability() {
        use crate::remote::transport::{SocketFrameReader, UnixStreamFrameWriter};

        let dir = tempfile::tempdir().unwrap();
        let manager =
            RemoteConnectionManager::new(&AppPaths::new(dir.path().to_path_buf())).unwrap();
        let (client, mut server) = std::os::unix::net::UnixStream::pair().unwrap();
        let bridge = std::thread::spawn(move || {
            let _hello = read_frame_bytes(&mut server).unwrap();
            write_envelope(
                &mut server,
                &agentport_remote_protocol::ServerEnvelope::Hello(fake_hello(vec![])),
            )
            .unwrap();
            while let Ok(Some(_)) = agentport_remote_protocol::read_frame(
                &mut server,
                agentport_remote_protocol::MAX_FRAME_BYTES,
            ) {}
        });
        manager
            .connect_with_transport(
                "dev_old",
                None,
                Box::new(SocketFrameReader::new(client.try_clone().unwrap())),
                Box::new(UnixStreamFrameWriter::new(client)),
            )
            .unwrap();
        let error = manager
            .upload_image("dev_old", b"\x89PNG\r\n\x1a\nbody")
            .unwrap_err();
        assert_eq!(error.code, "image_upload_unavailable");
        manager.disconnect("dev_old");
        drop(manager);
        bridge.join().unwrap();
    }

    #[test]
    fn upload_image_rejects_bytes_that_are_not_png_or_jpeg() {
        let dir = tempfile::tempdir().unwrap();
        let manager =
            RemoteConnectionManager::new(&AppPaths::new(dir.path().to_path_buf())).unwrap();
        let error = manager
            .upload_image("dev_img", b"GIF89a not an accepted paste")
            .unwrap_err();
        assert_eq!(error.code, "image_invalid");
    }
}
