use crate::credentials::load_credential;
use crate::hosts::{
    self, AuthenticationKind as ProfileAuthentication, HostProfile, PreferredTransport,
};
use crate::ssh::{self, AuthenticationKind, JumpHostRequest, SshProbeRequest};
use agentport_relay::{crypto::Identity, endpoint::connect_session_realtime as connect_session};
use agentport_remote_protocol::{classify_method, RetryClass, ServerEnvelope, PROTOCOL_MAJOR};
use russh::Disconnect;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use zeroize::{Zeroize, Zeroizing};

const MAX_ONLINE_HOSTS: usize = 5;
const MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;
const BRIDGE_COMMAND: &str = "agentport-remote-bridge serve --stdio";
const CONNECTION_STATE_EVENT: &str = "agentport-mobile://connection-state";
const INPUT_RESULT_EVENT: &str = "agentport-mobile://input-result";
const MAX_PENDING_INPUTS: usize = 256;

fn emit_connection_state<R: Runtime>(
    app: &AppHandle<R>,
    profile_id: &str,
    state: &'static str,
) -> tauri::Result<()> {
    if let Some(connections) = app.try_state::<RemoteConnections>() {
        if let Ok(mut phases) = connections.inner.phases.lock() {
            phases.insert(profile_id.to_string(), state);
        }
    }
    app.emit(
        CONNECTION_STATE_EVENT,
        json!({"profileId": profile_id, "state": state}),
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub(crate) profile_id: String,
    pub(crate) protocol_major: u16,
    pub(crate) protocol_minor: u16,
    pub(crate) agentport_version: String,
    pub(crate) platform: String,
    pub(crate) capabilities: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectError {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_key_hop: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandError {
    code: String,
    message: String,
    status: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteRequestCommand {
    profile_id: String,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    precondition: Option<Value>,
}

struct PendingRequest {
    accepted: bool,
    is_read: bool,
    response: oneshot::Sender<Result<Value, RemoteCommandError>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputResultEvent {
    batch_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<RemoteCommandError>,
}

struct Connection {
    generation: String,
    snapshot: ConnectionSnapshot,
    writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>>,
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    transport: Transport,
}

enum Transport {
    Ssh(ssh::AuthenticatedSsh),
    Relay(RelayLease),
}
struct RelayLease(tokio::task::AbortHandle);
impl Drop for RelayLease {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Clone)]
struct LocalSubscription {
    profile_id: String,
    topics: Vec<String>,
}

#[derive(Default)]
struct RemoteStateInner {
    connections: AsyncMutex<HashMap<String, Connection>>,
    connecting_profiles: Mutex<HashMap<String, String>>,
    phases: Mutex<HashMap<String, &'static str>>,
    subscriptions: Mutex<HashMap<String, LocalSubscription>>,
    cancelled_profiles: Mutex<HashSet<String>>,
}

#[derive(Clone, Default)]
pub struct RemoteConnections {
    inner: Arc<RemoteStateInner>,
}

impl RemoteConnections {
    pub(crate) fn connection_state(&self, profile_id: &str) -> &'static str {
        self.inner
            .phases
            .lock()
            .ok()
            .and_then(|phases| phases.get(profile_id).copied())
            .unwrap_or("disconnected")
    }

    fn owns_attempt(&self, profile_id: &str, token: &str) -> bool {
        self.inner
            .connecting_profiles
            .lock()
            .map(|attempts| attempts.get(profile_id).is_some_and(|value| value == token))
            .unwrap_or(false)
    }
}

fn retry_delay(attempt: u32) -> Duration {
    Duration::from_secs(1_u64 << attempt.min(5))
}

fn retryable_connect_error(error: &ConnectError) -> bool {
    // Only availability failures retry. Trust/authentication/protocol failures
    // require a user decision and must not repeatedly access locked credentials.
    matches!(
        error.code,
        "ssh_connection_failed"
            | "jump_ssh_connection_failed"
            | "jump_forward_failed"
            | "connection_timeout"
            | "bridge_hello_timeout"
            | "bridge_channel_failed"
            | "bridge_launch_failed"
            | "bridge_hello_failed"
            | "relay_unavailable"
    )
}

fn emit_attempt_state(
    app: &AppHandle,
    state: &RemoteConnections,
    profile_id: &str,
    token: &str,
    phase: &'static str,
) {
    if let Ok(attempts) = state.inner.connecting_profiles.lock() {
        if attempts
            .get(profile_id)
            .is_some_and(|current| current == token)
        {
            let _ = emit_connection_state(app, profile_id, phase);
        }
    }
}

fn authentication(profile: &HostProfile) -> AuthenticationKind {
    match profile.authentication {
        ProfileAuthentication::Password => AuthenticationKind::Password,
        ProfileAuthentication::PrivateKey => AuthenticationKind::PrivateKey,
    }
}

fn ssh_request(profile: &HostProfile, jump: Option<(&HostProfile, String)>) -> SshProbeRequest {
    SshProbeRequest {
        host_profile_id: profile.id.clone(),
        hostname: profile.hostname.clone(),
        port: profile.port,
        username: profile.username.clone(),
        credential_id: profile.credential_id.clone(),
        authentication: authentication(profile),
        expected_host_key: profile.trusted_host_key.clone(),
        jump: jump.map(|(jump, _)| JumpHostRequest {
            host_profile_id: jump.id.clone(),
            hostname: jump.hostname.clone(),
            port: jump.port,
            username: jump.username.clone(),
            credential_id: jump.credential_id.clone(),
            authentication: authentication(jump),
            expected_host_key: jump.trusted_host_key.clone(),
        }),
    }
}

async fn write_frame<W: AsyncWrite + Unpin + ?Sized>(
    writer: &mut W,
    value: &Value,
) -> Result<(), String> {
    let bytes = Zeroizing::new(serde_json::to_vec(value).map_err(|_| "Bridge request is invalid")?);
    let length = u32::try_from(bytes.len()).map_err(|_| "Bridge request is too large")?;
    if length > MAX_FRAME_BYTES {
        return Err("Bridge request is too large".into());
    }
    writer
        .write_all(&length.to_be_bytes())
        .await
        .map_err(|_| "Bridge write failed")?;
    writer
        .write_all(bytes.as_slice())
        .await
        .map_err(|_| "Bridge write failed")?;
    writer
        .flush()
        .await
        .map_err(|_| "Bridge write failed".to_string())
}

async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R,
) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let mut header = [0_u8; 4];
    match reader.read_exact(&mut header).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(_) => return Err("Bridge read failed".into()),
    }
    let length = u32::from_be_bytes(header);
    if length > MAX_FRAME_BYTES {
        return Err("Bridge response is too large".into());
    }
    let mut body = Zeroizing::new(vec![0_u8; length as usize]);
    reader
        .read_exact(body.as_mut_slice())
        .await
        .map_err(|_| "Bridge read failed".to_string())?;
    Ok(Some(body))
}

fn connect_error(failure: ssh::SshConnectFailure, has_jump: bool) -> ConnectError {
    let hop = if failure.reason.starts_with("jump_") {
        "jump"
    } else if has_jump {
        "target"
    } else {
        "direct"
    };
    ConnectError {
        code: failure.reason,
        message: failure.reason.replace('_', " "),
        fingerprint: failure.host_key_fingerprint,
        host_key_hop: Some(hop),
    }
}

async fn establish(
    app: &AppHandle,
    profile: &HostProfile,
) -> Result<
    (
        Transport,
        Box<dyn AsyncRead + Send + Unpin>,
        Box<dyn AsyncWrite + Send + Unpin>,
        ConnectionSnapshot,
    ),
    ConnectError,
> {
    let secret = load_credential(app, &profile.credential_id).map_err(|message| ConnectError {
        code: "credential_locked",
        message,
        fingerprint: None,
        host_key_hop: None,
    })?;
    if matches!(profile.preferred_transport, PreferredTransport::Relay) {
        return establish_relay_with_secret(profile, secret).await;
    }
    if profile.relay.is_some() {
        return Err(relay_error(agentport_relay::Error::Unauthorized));
    }
    let jump_profile = profile
        .jump
        .as_ref()
        .map(|jump| hosts::get_profile(app, &jump.host_profile_id))
        .transpose()
        .map_err(|message| ConnectError {
            code: "jump_profile_invalid",
            message,
            fingerprint: None,
            host_key_hop: Some("jump"),
        })?;
    let jump_secret = jump_profile
        .as_ref()
        .map(|jump| load_credential(app, &jump.credential_id))
        .transpose()
        .map_err(|message| ConnectError {
            code: "jump_credential_locked",
            message,
            fingerprint: None,
            host_key_hop: Some("jump"),
        })?;
    let (ssh, reader, writer, snapshot) =
        establish_with_secrets(profile, jump_profile.as_ref(), secret, jump_secret).await?;
    Ok((Transport::Ssh(ssh), reader, writer, snapshot))
}

pub(crate) async fn establish_with_secrets(
    profile: &HostProfile,
    jump_profile: Option<&HostProfile>,
    secret: Zeroizing<Vec<u8>>,
    jump_secret: Option<Zeroizing<Vec<u8>>>,
) -> Result<
    (
        ssh::AuthenticatedSsh,
        Box<dyn AsyncRead + Send + Unpin>,
        Box<dyn AsyncWrite + Send + Unpin>,
        ConnectionSnapshot,
    ),
    ConnectError,
> {
    if profile.relay.is_some()
        || matches!(profile.preferred_transport, PreferredTransport::Relay)
        || jump_profile.is_some_and(|jump| {
            jump.relay.is_some() || matches!(jump.preferred_transport, PreferredTransport::Relay)
        })
    {
        return Err(relay_error(agentport_relay::Error::Unauthorized));
    }
    let request = ssh_request(profile, jump_profile.map(|jump| (jump, String::new())));
    let connection = ssh::connect_authenticated_with_jump(
        &request,
        secret.as_slice(),
        jump_secret.as_ref().map(|value| value.as_slice()),
    )
    .await
    .map_err(|failure| connect_error(failure, jump_profile.is_some()))?;
    drop(secret);
    drop(jump_secret);
    let channel = connection
        .session
        .channel_open_session()
        .await
        .map_err(|_| ConnectError {
            code: "bridge_channel_failed",
            message: "Remote Bridge channel could not be opened".into(),
            fingerprint: None,
            host_key_hop: None,
        })?;
    channel
        .exec(true, BRIDGE_COMMAND)
        .await
        .map_err(|_| ConnectError {
            code: "bridge_launch_failed",
            message: "Remote Bridge could not be launched".into(),
            fingerprint: None,
            host_key_hop: None,
        })?;
    let stream = channel.into_stream();
    let (mut reader, mut writer) = tokio::io::split(stream);
    let snapshot = bridge_hello(&profile.id, &mut reader, &mut writer).await?;
    Ok((connection, Box::new(reader), Box::new(writer), snapshot))
}

async fn bridge_hello<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    profile_id: &str,
    reader: &mut R,
    writer: &mut W,
) -> Result<ConnectionSnapshot, ConnectError> {
    write_frame(
        writer,
        &json!({
            "type": "hello",
            "protocol": {"major": 1, "minor": 1},
            "client": {"name": "agentport-mobile", "version": env!("CARGO_PKG_VERSION")},
            "requestedCapabilities": ["session.event_push", "terminal.geometry_v1"]
        }),
    )
    .await
    .map_err(|message| ConnectError {
        code: "bridge_hello_failed",
        message,
        fingerprint: None,
        host_key_hop: None,
    })?;
    let body = tokio::time::timeout(Duration::from_secs(10), read_frame(reader))
        .await
        .map_err(|_| ConnectError {
            code: "bridge_hello_timeout",
            message: "Remote Bridge hello timed out".into(),
            fingerprint: None,
            host_key_hop: None,
        })?
        .map_err(|message| ConnectError {
            code: "bridge_hello_failed",
            message,
            fingerprint: None,
            host_key_hop: None,
        })?
        .ok_or_else(|| ConnectError {
            code: "bridge_hello_failed",
            message: "Remote Bridge closed during hello".into(),
            fingerprint: None,
            host_key_hop: None,
        })?;
    let envelope: ServerEnvelope =
        serde_json::from_slice(body.as_slice()).map_err(|_| ConnectError {
            code: "bridge_protocol_invalid",
            message: "Remote Bridge hello is invalid".into(),
            fingerprint: None,
            host_key_hop: None,
        })?;
    let hello = match envelope {
        ServerEnvelope::Hello(hello) if hello.protocol.major == PROTOCOL_MAJOR => hello,
        ServerEnvelope::Incompatible { message, .. } => {
            return Err(ConnectError {
                code: "bridge_protocol_incompatible",
                message,
                fingerprint: None,
                host_key_hop: None,
            });
        }
        _ => {
            return Err(ConnectError {
                code: "bridge_protocol_invalid",
                message: "Remote Bridge hello is invalid".into(),
                fingerprint: None,
                host_key_hop: None,
            });
        }
    };
    let snapshot = ConnectionSnapshot {
        profile_id: profile_id.to_string(),
        protocol_major: hello.protocol.major,
        protocol_minor: hello.protocol.minor,
        agentport_version: hello.server.agentport_version,
        platform: hello.server.platform,
        capabilities: hello
            .capabilities
            .into_iter()
            .filter_map(|capability| serde_json::to_value(capability).ok())
            .collect(),
    };
    Ok(snapshot)
}

fn relay_error(error: agentport_relay::Error) -> ConnectError {
    let code = match error {
        agentport_relay::Error::Unauthorized => "relay_authentication_failed",
        agentport_relay::Error::Protocol | agentport_relay::Error::Invalid(_) => {
            "relay_identity_invalid"
        }
        agentport_relay::Error::Credential | agentport_relay::Error::Storage => "credential_locked",
        _ => "relay_unavailable",
    };
    ConnectError {
        code,
        message: error.to_string(),
        fingerprint: None,
        host_key_hop: None,
    }
}
async fn establish_relay_with_secret(
    profile: &HostProfile,
    secret: Zeroizing<Vec<u8>>,
) -> Result<
    (
        Transport,
        Box<dyn AsyncRead + Send + Unpin>,
        Box<dyn AsyncWrite + Send + Unpin>,
        ConnectionSnapshot,
    ),
    ConnectError,
> {
    let relay = profile
        .relay
        .as_ref()
        .ok_or_else(|| relay_error(agentport_relay::Error::Unauthorized))?;
    relay
        .validate()
        .map_err(|_| relay_error(agentport_relay::Error::Unauthorized))?;
    if !relay.approved || profile.jump.is_some() {
        return Err(relay_error(agentport_relay::Error::Unauthorized));
    }
    let identity = Identity::from_private(secret).map_err(relay_error)?;
    if relay.device_public_key.as_deref() != Some(identity.public_key().as_str()) {
        return Err(relay_error(agentport_relay::Error::Unauthorized));
    }
    let stream = connect_session(&identity, &relay.peer)
        .await
        .map_err(relay_error)?;
    let transport = Transport::Relay(RelayLease(stream.abort_handle()));
    let (mut reader, mut writer) = tokio::io::split(stream);
    let snapshot = bridge_hello(&profile.id, &mut reader, &mut writer).await?;
    Ok((transport, Box::new(reader), Box::new(writer), snapshot))
}

fn zeroize_value(value: &mut Value) {
    match value {
        Value::String(text) => text.zeroize(),
        Value::Array(values) => values.iter_mut().for_each(zeroize_value),
        Value::Object(values) => values.values_mut().for_each(zeroize_value),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn remote_error_status(status: &str) -> &'static str {
    match status {
        "unknown" => "unknown",
        "not_executed" => "not_executed",
        _ => "failed",
    }
}

fn fail_pending(pending: &Arc<Mutex<HashMap<String, PendingRequest>>>) {
    if let Ok(mut requests) = pending.lock() {
        for (_, request) in requests.drain() {
            let status = if request.accepted || !request.is_read {
                "unknown"
            } else {
                "not_executed"
            };
            let _ = request.response.send(Err(RemoteCommandError {
                code: format!("connection_{status}"),
                message: if status == "unknown" { "The connection ended before the write result was known. The operation was not replayed." } else { "The connection ended before the request executed." }.into(),
                status,
            }));
        }
    }
}

async fn reader_loop(
    app: AppHandle,
    state: RemoteConnections,
    profile_id: String,
    mut generation: String,
    mut reader: Box<dyn AsyncRead + Send + Unpin>,
    mut pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
) {
    loop {
        while let Ok(Some(body)) = read_frame(&mut reader).await {
            let Ok(envelope) = serde_json::from_slice::<Value>(body.as_slice()) else {
                break;
            };
            match envelope.get("type").and_then(Value::as_str) {
                Some("accepted") => {
                    if let Some(request_id) = envelope.get("requestId").and_then(Value::as_str) {
                        if let Ok(mut requests) = pending.lock() {
                            if let Some(request) = requests.get_mut(request_id) {
                                request.accepted = true;
                            }
                        }
                    }
                }
                Some("result") => {
                    if let Some(request_id) = envelope.get("requestId").and_then(Value::as_str) {
                        let request = pending
                            .lock()
                            .ok()
                            .and_then(|mut requests| requests.remove(request_id));
                        if let Some(request) = request {
                            let status = envelope
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("failed");
                            let response = if status == "succeeded" {
                                Ok(envelope.get("value").cloned().unwrap_or(Value::Null))
                            } else {
                                let remote = envelope.get("error").cloned().unwrap_or(Value::Null);
                                Err(RemoteCommandError {
                                    code: remote
                                        .get("code")
                                        .and_then(Value::as_str)
                                        .unwrap_or("remote_request_failed")
                                        .into(),
                                    message: remote
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("Remote request failed")
                                        .into(),
                                    status: remote_error_status(status),
                                })
                            };
                            let _ = request.response.send(response);
                        }
                    }
                }
                Some("event") => {
                    let subscriptions = state
                        .inner
                        .subscriptions
                        .lock()
                        .map(|values| values.clone())
                        .unwrap_or_default();
                    let event_type = envelope
                        .get("eventType")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    for (id, subscription) in subscriptions {
                        if subscription.profile_id == profile_id
                            && (subscription.topics.is_empty()
                                || subscription
                                    .topics
                                    .iter()
                                    .any(|topic| event_type.starts_with(topic)))
                        {
                            let _ = app.emit(&format!("agentport-mobile://remote/{id}"), &envelope);
                        }
                    }
                }
                _ => break,
            }
        }
        fail_pending(&pending);
        {
            let mut connections = state.inner.connections.lock().await;
            if connections
                .get(&profile_id)
                .is_some_and(|connection| connection.generation == generation)
            {
                connections.remove(&profile_id);
            } else {
                return;
            }
        }

        let next_token = format!("connection_{}", uuid::Uuid::new_v4().simple());
        {
            let mut attempts = match state.inner.connecting_profiles.lock() {
                Ok(value) => value,
                Err(_) => return,
            };
            if attempts.contains_key(&profile_id)
                || state
                    .inner
                    .cancelled_profiles
                    .lock()
                    .map(|values| values.contains(&profile_id))
                    .unwrap_or(true)
            {
                return;
            }
            attempts.insert(profile_id.clone(), next_token.clone());
        }
        let mut reconnected = None;
        let mut attempt = 0_u32;
        while state.owns_attempt(&profile_id, &next_token) {
            emit_attempt_state(&app, &state, &profile_id, &next_token, "reconnecting");
            tokio::time::sleep(retry_delay(attempt)).await;
            attempt = attempt.saturating_add(1);
            if !state.owns_attempt(&profile_id, &next_token) {
                return;
            }
            let Ok(profile) = hosts::get_profile(&app, &profile_id) else {
                break;
            };
            if !profile.enabled {
                break;
            }
            match tokio::time::timeout(Duration::from_secs(30), establish(&app, &profile)).await {
                Ok(Ok(established)) => {
                    reconnected = Some(established);
                    break;
                }
                Ok(Err(error)) if !retryable_connect_error(&error) => break,
                _ => {}
            }
        }
        if !state.owns_attempt(&profile_id, &next_token) {
            return;
        }
        let Some((transport, next_reader, writer, snapshot)) = reconnected else {
            if let Ok(mut attempts) = state.inner.connecting_profiles.lock() {
                if attempts.get(&profile_id) == Some(&next_token) {
                    attempts.remove(&profile_id);
                    let _ = emit_connection_state(&app, &profile_id, "failed");
                }
            }
            return;
        };
        let next_generation = next_token.clone();
        let next_pending = Arc::new(Mutex::new(HashMap::new()));
        let mut connections = state.inner.connections.lock().await;
        if connections.contains_key(&profile_id) || !state.owns_attempt(&profile_id, &next_token) {
            return;
        }
        if connections.len() >= MAX_ONLINE_HOSTS {
            if let Ok(mut attempts) = state.inner.connecting_profiles.lock() {
                if attempts.get(&profile_id) == Some(&next_token) {
                    attempts.remove(&profile_id);
                    let _ = emit_connection_state(&app, &profile_id, "failed");
                }
            }
            return;
        }
        connections.insert(
            profile_id.clone(),
            Connection {
                generation: next_generation.clone(),
                snapshot,
                writer: Arc::new(AsyncMutex::new(writer)),
                pending: Arc::clone(&next_pending),
                transport,
            },
        );
        state
            .inner
            .connecting_profiles
            .lock()
            .ok()
            .map(|mut attempts| attempts.remove(&profile_id));
        let _ = emit_connection_state(&app, &profile_id, "connected");
        drop(connections);
        generation = next_generation;
        reader = next_reader;
        pending = next_pending;
    }
}

#[tauri::command]
pub async fn mobile_connect_host(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    profile_id: String,
) -> Result<ConnectionSnapshot, ConnectError> {
    if let Ok(mut cancelled) = state.inner.cancelled_profiles.lock() {
        cancelled.remove(&profile_id);
    }
    let profile = hosts::get_profile(&app, &profile_id).map_err(|message| ConnectError {
        code: "host_profile_invalid",
        message,
        fingerprint: None,
        host_key_hop: None,
    })?;
    if !profile.enabled {
        return Err(ConnectError {
            code: "host_disabled",
            message: "Host profile is disabled".into(),
            fingerprint: None,
            host_key_hop: None,
        });
    }
    let generation = format!("connection_{}", uuid::Uuid::new_v4().simple());
    {
        let connections = state.inner.connections.lock().await;
        if let Some(connection) = connections.get(&profile_id) {
            let snapshot = connection.snapshot.clone();
            let _ = emit_connection_state(&app, &profile_id, "connected");
            drop(connections);
            return Ok(snapshot);
        }
        let mut connecting = state
            .inner
            .connecting_profiles
            .lock()
            .map_err(|_| ConnectError {
                code: "connection_state_unavailable",
                message: "Connection state is unavailable".into(),
                fingerprint: None,
                host_key_hop: None,
            })?;
        if connecting.contains_key(&profile_id) {
            return Err(ConnectError {
                code: "connection_in_progress",
                message: "This host is already connecting".into(),
                fingerprint: None,
                host_key_hop: None,
            });
        }
        if connections.len() + connecting.len() >= MAX_ONLINE_HOSTS {
            return Err(ConnectError {
                code: "online_host_limit",
                message: "At most five hosts can be online or connecting".into(),
                fingerprint: None,
                host_key_hop: None,
            });
        }
        connecting.insert(profile_id.clone(), generation.clone());
    }
    emit_attempt_state(&app, &state, &profile_id, &generation, "connecting");
    let established = tokio::time::timeout(Duration::from_secs(30), establish(&app, &profile))
        .await
        .unwrap_or_else(|_| {
            Err(ConnectError {
                code: "connection_timeout",
                message: "Connection timed out".into(),
                fingerprint: None,
                host_key_hop: None,
            })
        });
    let mut connections = state.inner.connections.lock().await;
    if !state.owns_attempt(&profile_id, &generation) {
        return Err(ConnectError {
            code: "connection_cancelled",
            message: "Connection was cancelled".into(),
            fingerprint: None,
            host_key_hop: None,
        });
    }
    state
        .inner
        .connecting_profiles
        .lock()
        .ok()
        .map(|mut attempts| attempts.remove(&profile_id));
    let (transport, reader, writer, snapshot) = established.map_err(|error| {
        let _ = emit_connection_state(&app, &profile_id, "failed");
        error
    })?;
    let pending = Arc::new(Mutex::new(HashMap::new()));
    connections.insert(
        profile_id.clone(),
        Connection {
            generation: generation.clone(),
            snapshot: snapshot.clone(),
            writer: Arc::new(AsyncMutex::new(writer)),
            pending: Arc::clone(&pending),
            transport,
        },
    );
    let _ = emit_connection_state(&app, &profile_id, "connected");
    drop(connections);
    tauri::async_runtime::spawn(reader_loop(
        app.clone(),
        state.inner().clone(),
        profile_id.clone(),
        generation,
        reader,
        pending,
    ));
    Ok(snapshot)
}

#[tauri::command]
pub async fn mobile_disconnect_host(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    profile_id: String,
) -> Result<(), String> {
    if let Ok(mut cancelled) = state.inner.cancelled_profiles.lock() {
        cancelled.insert(profile_id.clone());
    }
    let mut connections = state.inner.connections.lock().await;
    state
        .inner
        .connecting_profiles
        .lock()
        .ok()
        .map(|mut attempts| attempts.remove(&profile_id));
    let connection = connections.remove(&profile_id);
    let _ = emit_connection_state(&app, &profile_id, "disconnected");
    drop(connections);
    if let Some(connection) = connection {
        fail_pending(&connection.pending);
        match connection.transport {
            Transport::Ssh(ssh) => {
                let _ = ssh
                    .session
                    .disconnect(Disconnect::ByApplication, "user disconnected", "en")
                    .await;
                if let Some(jump) = ssh.jump_session {
                    let _ = jump
                        .disconnect(Disconnect::ByApplication, "user disconnected", "en")
                        .await;
                }
            }
            Transport::Relay(lease) => drop(lease),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_remote_submit_input(
    app: AppHandle,
    state: State<'_, RemoteConnections>,
    command: RemoteRequestCommand,
) -> Result<(), RemoteCommandError> {
    if command.method != "session.input" {
        return Err(RemoteCommandError {
            code: "invalid_input_request".into(),
            message: "Only session input can use the ordered submit path".into(),
            status: "not_executed",
        });
    }
    let batch_id = command
        .params
        .get("batchId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| RemoteCommandError {
            code: "invalid_input_request".into(),
            message: "Input batch ID is required".into(),
            status: "not_executed",
        })?
        .to_string();
    let request_id = format!("request_{}", uuid::Uuid::new_v4().simple());
    let (sender, receiver) = oneshot::channel();
    let (writer, pending) = {
        let connections = state.inner.connections.lock().await;
        let connection =
            connections
                .get(&command.profile_id)
                .ok_or_else(|| RemoteCommandError {
                    code: "host_not_connected".into(),
                    message: "Host is not connected".into(),
                    status: "not_executed",
                })?;
        (
            Arc::clone(&connection.writer),
            Arc::clone(&connection.pending),
        )
    };
    {
        let mut requests = pending.lock().map_err(|_| RemoteCommandError {
            code: "connection_state_unavailable".into(),
            message: "Connection state is unavailable".into(),
            status: "not_executed",
        })?;
        if requests.len() >= MAX_PENDING_INPUTS {
            return Err(RemoteCommandError {
                code: "input_queue_full".into(),
                message: "Too many input batches are awaiting results".into(),
                status: "not_executed",
            });
        }
        requests.insert(
            request_id.clone(),
            PendingRequest {
                accepted: false,
                is_read: false,
                response: sender,
            },
        );
    }
    let mut frame = json!({"type": "request", "requestId": request_id.clone(), "method": command.method, "params": command.params, "precondition": command.precondition});
    let write_failed = write_frame(writer.lock().await.as_mut(), &frame)
        .await
        .is_err();
    zeroize_value(&mut frame);
    if write_failed {
        pending
            .lock()
            .ok()
            .and_then(|mut requests| requests.remove(&request_id));
        return Err(RemoteCommandError {
            code: "connection_unknown".into(),
            message: "The input could not be submitted and was not replayed".into(),
            status: "unknown",
        });
    }
    tauri::async_runtime::spawn(async move {
        let outcome = receiver.await.unwrap_or_else(|_| {
            Err(RemoteCommandError {
                code: "connection_unknown".into(),
                message: "The connection ended before the input result was known".into(),
                status: "unknown",
            })
        });
        let payload = match outcome {
            Ok(value) => InputResultEvent {
                batch_id,
                value: Some(value),
                error: None,
            },
            Err(error) => InputResultEvent {
                batch_id,
                value: None,
                error: Some(error),
            },
        };
        let _ = app.emit(INPUT_RESULT_EVENT, payload);
    });
    Ok(())
}

#[tauri::command]
pub async fn mobile_remote_request(
    state: State<'_, RemoteConnections>,
    command: RemoteRequestCommand,
) -> Result<Value, RemoteCommandError> {
    let request_id = format!("request_{}", uuid::Uuid::new_v4().simple());
    let is_read = classify_method(&command.method) == RetryClass::Read;
    let (sender, receiver) = oneshot::channel();
    let (writer, pending) = {
        let connections = state.inner.connections.lock().await;
        let connection =
            connections
                .get(&command.profile_id)
                .ok_or_else(|| RemoteCommandError {
                    code: "host_not_connected".into(),
                    message: "Host is not connected".into(),
                    status: "not_executed",
                })?;
        (
            Arc::clone(&connection.writer),
            Arc::clone(&connection.pending),
        )
    };
    pending
        .lock()
        .map_err(|_| RemoteCommandError {
            code: "connection_state_unavailable".into(),
            message: "Connection state is unavailable".into(),
            status: "not_executed",
        })?
        .insert(
            request_id.clone(),
            PendingRequest {
                accepted: false,
                is_read,
                response: sender,
            },
        );
    let mut frame = json!({"type": "request", "requestId": request_id.clone(), "method": command.method, "params": command.params, "precondition": command.precondition});
    let write_failed = write_frame(writer.lock().await.as_mut(), &frame)
        .await
        .is_err();
    zeroize_value(&mut frame);
    if write_failed {
        let request = pending
            .lock()
            .ok()
            .and_then(|mut requests| requests.remove(&request_id));
        if let Some(request) = request {
            let status = if request.is_read {
                "not_executed"
            } else {
                "unknown"
            };
            return Err(RemoteCommandError {
                code: format!("connection_{status}"),
                message: "The request could not be completed and was not replayed".into(),
                status,
            });
        }
    }
    receiver.await.unwrap_or_else(|_| {
        Err(RemoteCommandError {
            code: "connection_unknown".into(),
            message: "The connection ended before the result was known".into(),
            status: "unknown",
        })
    })
}

#[tauri::command]
pub fn mobile_subscribe(
    state: State<'_, RemoteConnections>,
    profile_id: String,
    topics: Vec<String>,
) -> Result<String, String> {
    if topics.len() > 64 || topics.iter().any(|topic| topic.len() > 128) {
        return Err("invalid subscription topics".into());
    }
    let id = format!("subscription_{}", uuid::Uuid::new_v4().simple());
    state
        .inner
        .subscriptions
        .lock()
        .map_err(|_| "subscription state is unavailable")?
        .insert(id.clone(), LocalSubscription { profile_id, topics });
    Ok(id)
}

#[tauri::command]
pub fn mobile_unsubscribe(
    state: State<'_, RemoteConnections>,
    profile_id: String,
    subscription_id: String,
) -> Result<(), String> {
    let mut subscriptions = state
        .inner
        .subscriptions
        .lock()
        .map_err(|_| "subscription state is unavailable")?;
    if subscriptions
        .get(&subscription_id)
        .is_some_and(|value| value.profile_id == profile_id)
    {
        subscriptions.remove(&subscription_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tauri::Listener;

    #[test]
    fn explicit_connect_and_disconnect_states_are_broadcast_to_all_consumers() {
        let app = tauri::test::mock_app();
        app.manage(RemoteConnections::default());
        let received = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&received);
        app.listen(CONNECTION_STATE_EVENT, move |event| {
            captured
                .lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });

        emit_connection_state(app.handle(), "host_local", "connected").unwrap();
        assert_eq!(
            app.state::<RemoteConnections>()
                .connection_state("host_local"),
            "connected"
        );
        emit_connection_state(app.handle(), "host_local", "disconnected").unwrap();
        assert_eq!(
            app.state::<RemoteConnections>()
                .connection_state("host_local"),
            "disconnected"
        );

        assert_eq!(
            *received.lock().unwrap(),
            vec![
                json!({"profileId": "host_local", "state": "connected"}),
                json!({"profileId": "host_local", "state": "disconnected"}),
            ]
        );
    }

    #[test]
    fn disconnect_never_replays_writes_and_preserves_read_retry_classification() {
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (write_sender, mut write_receiver) = oneshot::channel();
        let (read_sender, mut read_receiver) = oneshot::channel();
        pending.lock().unwrap().insert(
            "write".into(),
            PendingRequest {
                accepted: false,
                is_read: false,
                response: write_sender,
            },
        );
        pending.lock().unwrap().insert(
            "read".into(),
            PendingRequest {
                accepted: false,
                is_read: true,
                response: read_sender,
            },
        );
        fail_pending(&pending);
        assert_eq!(
            write_receiver.try_recv().unwrap().unwrap_err().status,
            "unknown"
        );
        assert_eq!(
            read_receiver.try_recv().unwrap().unwrap_err().status,
            "not_executed"
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[test]
    fn reconnect_backoff_survives_long_outages_but_auth_failures_do_not_retry() {
        assert_eq!(retry_delay(0).as_secs(), 1);
        assert_eq!(retry_delay(100).as_secs(), 32);
        for (code, retry) in [
            ("ssh_connection_failed", true),
            ("ssh_authentication_failed", false),
            ("credential_locked", false),
            ("ssh_host_key_changed", false),
        ] {
            assert_eq!(
                retryable_connect_error(&ConnectError {
                    code,
                    message: String::new(),
                    fingerprint: None,
                    host_key_hop: None
                }),
                retry
            );
        }
    }

    #[test]
    fn a_cancelled_or_replaced_attempt_cannot_publish_a_late_connection() {
        let state = RemoteConnections::default();
        state
            .inner
            .connecting_profiles
            .lock()
            .unwrap()
            .insert("host".into(), "old".into());
        assert!(state.owns_attempt("host", "old"));
        state
            .inner
            .connecting_profiles
            .lock()
            .unwrap()
            .remove("host");
        assert!(!state.owns_attempt("host", "old"));
        state
            .inner
            .connecting_profiles
            .lock()
            .unwrap()
            .insert("host".into(), "new".into());
        assert!(!state.owns_attempt("host", "old"));
        assert!(state.owns_attempt("host", "new"));
    }

    #[test]
    fn online_limit_is_product_bounded() {
        assert_eq!(MAX_ONLINE_HOSTS, 5);
        assert_eq!(MAX_PENDING_INPUTS, 256);
    }

    #[test]
    fn remote_result_status_preserves_not_executed_and_unknown() {
        assert_eq!(remote_error_status("not_executed"), "not_executed");
        assert_eq!(remote_error_status("unknown"), "unknown");
        assert_eq!(remote_error_status("failed"), "failed");
    }

    #[test]
    fn outbound_request_values_are_wiped_after_framing() {
        let mut value = json!({"params": {"prompt": "sensitive", "nested": ["secret"]}});
        zeroize_value(&mut value);
        assert_eq!(value["params"]["prompt"], "");
        assert_eq!(value["params"]["nested"][0], "");
    }
}

#[cfg(test)]
#[path = "relay_transport_tests.rs"]
mod relay_transport_tests;
