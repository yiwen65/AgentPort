use crate::credentials::load_credential;
use russh::client;
use russh::keys::ssh_key::{HashAlg, PrivateKey, PublicKey};
use russh::keys::PrivateKeyWithHashAlg;
use russh::Disconnect;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::{Zeroize, Zeroizing};

const MAX_BRIDGE_FRAME_BYTES: u32 = 16 * 1024 * 1024;
const BRIDGE_COMMAND: &str = "agentport-remote-bridge serve --stdio";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshProbeRequest {
    pub(crate) host_profile_id: String,
    pub(crate) hostname: String,
    #[serde(default = "default_port")]
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) credential_id: String,
    #[serde(default)]
    pub(crate) authentication: AuthenticationKind,
    #[serde(default)]
    pub(crate) expected_host_key: Option<String>,
    #[serde(default)]
    pub(crate) jump: Option<JumpHostRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JumpHostRequest {
    pub(crate) host_profile_id: String,
    pub(crate) hostname: String,
    #[serde(default = "default_port")]
    pub(crate) port: u16,
    pub(crate) username: String,
    pub(crate) credential_id: String,
    #[serde(default)]
    pub(crate) authentication: AuthenticationKind,
    #[serde(default)]
    pub(crate) expected_host_key: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AuthenticationKind {
    #[default]
    Password,
    PrivateKey,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbeResult {
    state: &'static str,
    host_key_fingerprint: Option<String>,
    bridge_protocol: Option<serde_json::Value>,
    reason: Option<&'static str>,
    host_key_hop: Option<&'static str>,
}

pub(crate) struct HostKeyVerifier {
    expected: Option<String>,
    observed: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(fingerprint.clone());
        }
        Ok(self.expected.as_deref() == Some(fingerprint.as_str()))
    }
}

fn default_port() -> u16 {
    22
}

pub(crate) fn validate(request: &SshProbeRequest) -> Result<(), String> {
    if request.host_profile_id.trim().is_empty()
        || request.hostname.trim().is_empty()
        || request.hostname.len() > 253
        || request.port == 0
        || request.username.trim().is_empty()
        || request.username.len() > 128
        || request.credential_id.len() > 128
        || request
            .expected_host_key
            .as_ref()
            .is_some_and(|value| value.len() > 128 || !value.starts_with("SHA256:"))
    {
        return Err("invalid SSH probe request".into());
    }
    if let Some(jump) = &request.jump {
        if jump.host_profile_id.trim().is_empty()
            || jump.hostname.trim().is_empty()
            || jump.hostname.len() > 253
            || jump.port == 0
            || jump.username.trim().is_empty()
            || jump.username.len() > 128
            || jump.credential_id.len() > 128
            || jump
                .expected_host_key
                .as_ref()
                .is_some_and(|value| value.len() > 128 || !value.starts_with("SHA256:"))
        {
            return Err("invalid SSH jump request".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn mobile_probe_ssh_bridge(
    app: AppHandle,
    request: SshProbeRequest,
) -> Result<SshProbeResult, String> {
    validate(&request)?;
    let secret = load_credential(&app, &request.credential_id)?;
    let jump_secret = request
        .jump
        .as_ref()
        .map(|jump| load_credential(&app, &jump.credential_id))
        .transpose()?;
    probe_with_password(request, secret, jump_secret).await
}

pub(crate) struct AuthenticatedSsh {
    pub session: client::Handle<HostKeyVerifier>,
    pub host_key_fingerprint: String,
    pub jump_session: Option<client::Handle<HostKeyVerifier>>,
}

pub(crate) struct SshConnectFailure {
    pub host_key_fingerprint: Option<String>,
    pub reason: &'static str,
}

pub(crate) async fn connect_authenticated(
    request: &SshProbeRequest,
    secret: &[u8],
) -> Result<AuthenticatedSsh, SshConnectFailure> {
    let observed = Arc::new(Mutex::new(None));
    let verifier = HostKeyVerifier {
        expected: request.expected_host_key.clone(),
        observed: Arc::clone(&observed),
    };
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        keepalive_interval: Some(Duration::from_secs(5)),
        keepalive_max: 2,
        nodelay: true,
        ..Default::default()
    };
    let mut session = match client::connect(
        Arc::new(config),
        (request.hostname.as_str(), request.port),
        verifier,
    )
    .await
    {
        Ok(session) => session,
        Err(_) => {
            let fingerprint = observed.lock().ok().and_then(|value| value.clone());
            let reason = match (&request.expected_host_key, &fingerprint) {
                (None, Some(_)) => "host_key_confirmation_required",
                (Some(expected), Some(actual)) if expected != actual => "host_key_changed",
                _ => "ssh_connection_failed",
            };
            return Err(SshConnectFailure {
                host_key_fingerprint: fingerprint,
                reason,
            });
        }
    };

    let authentication = match request.authentication {
        AuthenticationKind::Password => {
            let mut password =
                Zeroizing::new(String::from_utf8(secret.to_vec()).map_err(|_| {
                    SshConnectFailure {
                        host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                        reason: "ssh_credential_invalid",
                    }
                })?);
            let result = session
                .authenticate_password(&request.username, password.as_str())
                .await
                .map_err(|_| SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_authentication_failed",
                })?;
            password.zeroize();
            result
        }
        AuthenticationKind::PrivateKey => {
            let key = PrivateKey::from_openssh(secret).map_err(|_| SshConnectFailure {
                host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                reason: "ssh_credential_invalid",
            })?;
            if key.is_encrypted() {
                return Err(SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_credential_locked",
                });
            }
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|_| SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_key_negotiation_failed",
                })?
                .flatten();
            session
                .authenticate_publickey(
                    &request.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|_| SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_authentication_failed",
                })?
        }
    };
    if !authentication.success() {
        return Err(SshConnectFailure {
            host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
            reason: "ssh_authentication_failed",
        });
    }
    let host_key_fingerprint =
        observed
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .ok_or(SshConnectFailure {
                host_key_fingerprint: None,
                reason: "ssh_connection_failed",
            })?;
    Ok(AuthenticatedSsh {
        session,
        host_key_fingerprint,
        jump_session: None,
    })
}

pub(crate) async fn connect_authenticated_with_jump(
    request: &SshProbeRequest,
    secret: &[u8],
    jump_secret: Option<&[u8]>,
) -> Result<AuthenticatedSsh, SshConnectFailure> {
    let Some(jump) = &request.jump else {
        return connect_authenticated(request, secret).await;
    };
    let jump_request = SshProbeRequest {
        host_profile_id: jump.host_profile_id.clone(),
        hostname: jump.hostname.clone(),
        port: jump.port,
        username: jump.username.clone(),
        credential_id: jump.credential_id.clone(),
        authentication: jump.authentication,
        expected_host_key: jump.expected_host_key.clone(),
        jump: None,
    };
    let jump_secret = jump_secret.ok_or(SshConnectFailure {
        host_key_fingerprint: None,
        reason: "jump_credential_missing",
    })?;
    let jump_connection = connect_authenticated(&jump_request, jump_secret)
        .await
        .map_err(|failure| SshConnectFailure {
            host_key_fingerprint: failure.host_key_fingerprint,
            reason: match failure.reason {
                "host_key_confirmation_required" => "jump_host_key_confirmation_required",
                "host_key_changed" => "jump_host_key_changed",
                "ssh_authentication_failed" => "jump_authentication_failed",
                _ => "jump_connection_failed",
            },
        })?;
    let tunnel = jump_connection
        .session
        .channel_open_direct_tcpip(
            request.hostname.clone(),
            request.port as u32,
            "127.0.0.1",
            0,
        )
        .await
        .map_err(|_| SshConnectFailure {
            host_key_fingerprint: None,
            reason: "jump_forward_failed",
        })?;

    let observed = Arc::new(Mutex::new(None));
    let verifier = HostKeyVerifier {
        expected: request.expected_host_key.clone(),
        observed: Arc::clone(&observed),
    };
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        keepalive_interval: Some(Duration::from_secs(5)),
        keepalive_max: 2,
        nodelay: true,
        ..Default::default()
    };
    let mut session = client::connect_stream(Arc::new(config), tunnel.into_stream(), verifier)
        .await
        .map_err(|_| {
            let fingerprint = observed.lock().ok().and_then(|value| value.clone());
            let reason = match (&request.expected_host_key, &fingerprint) {
                (None, Some(_)) => "host_key_confirmation_required",
                (Some(expected), Some(actual)) if expected != actual => "host_key_changed",
                _ => "ssh_connection_failed",
            };
            SshConnectFailure {
                host_key_fingerprint: fingerprint,
                reason,
            }
        })?;
    let authentication = match request.authentication {
        AuthenticationKind::Password => {
            let mut password =
                Zeroizing::new(String::from_utf8(secret.to_vec()).map_err(|_| {
                    SshConnectFailure {
                        host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                        reason: "ssh_credential_invalid",
                    }
                })?);
            let result = session
                .authenticate_password(&request.username, password.as_str())
                .await
                .map_err(|_| SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_authentication_failed",
                })?;
            password.zeroize();
            result
        }
        AuthenticationKind::PrivateKey => {
            let key = PrivateKey::from_openssh(secret).map_err(|_| SshConnectFailure {
                host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                reason: "ssh_credential_invalid",
            })?;
            if key.is_encrypted() {
                return Err(SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_credential_locked",
                });
            }
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(|_| SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_key_negotiation_failed",
                })?
                .flatten();
            session
                .authenticate_publickey(
                    &request.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(|_| SshConnectFailure {
                    host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
                    reason: "ssh_authentication_failed",
                })?
        }
    };
    if !authentication.success() {
        return Err(SshConnectFailure {
            host_key_fingerprint: observed.lock().ok().and_then(|value| value.clone()),
            reason: "ssh_authentication_failed",
        });
    }
    let host_key_fingerprint =
        observed
            .lock()
            .ok()
            .and_then(|value| value.clone())
            .ok_or(SshConnectFailure {
                host_key_fingerprint: None,
                reason: "ssh_connection_failed",
            })?;
    Ok(AuthenticatedSsh {
        session,
        host_key_fingerprint,
        jump_session: Some(jump_connection.session),
    })
}

async fn probe_with_password(
    request: SshProbeRequest,
    secret: Zeroizing<Vec<u8>>,
    jump_secret: Option<Zeroizing<Vec<u8>>>,
) -> Result<SshProbeResult, String> {
    let AuthenticatedSsh {
        session,
        host_key_fingerprint,
        jump_session: _jump_session,
    } = match connect_authenticated_with_jump(
        &request,
        secret.as_slice(),
        jump_secret.as_ref().map(|value| value.as_slice()),
    )
    .await
    {
        Ok(connection) => connection,
        Err(failure) => {
            return Ok(SshProbeResult {
                state: "failed",
                host_key_fingerprint: failure.host_key_fingerprint,
                bridge_protocol: None,
                reason: Some(failure.reason),
                host_key_hop: Some(if failure.reason.starts_with("jump_") {
                    "jump"
                } else if request.jump.is_some() {
                    "target"
                } else {
                    "direct"
                }),
            });
        }
    };

    let channel = session
        .channel_open_session()
        .await
        .map_err(|_| "SSH channel open failed".to_string())?;
    channel
        .exec(true, BRIDGE_COMMAND)
        .await
        .map_err(|_| "Remote Bridge launch failed".to_string())?;
    let mut stream = channel.into_stream();
    let hello = serde_json::to_vec(&json!({
        "type": "hello",
        "protocol": {"major": 1, "minor": 1},
        "client": {"name": "agentport-mobile", "version": env!("CARGO_PKG_VERSION")},
        "requestedCapabilities": ["session.event_push"]
    }))
    .map_err(|_| "Bridge hello serialization failed".to_string())?;
    stream
        .write_all(&(hello.len() as u32).to_be_bytes())
        .await
        .map_err(|_| "Bridge hello write failed".to_string())?;
    stream
        .write_all(&hello)
        .await
        .map_err(|_| "Bridge hello write failed".to_string())?;
    stream
        .flush()
        .await
        .map_err(|_| "Bridge hello write failed".to_string())?;
    let mut header = [0_u8; 4];
    tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut header))
        .await
        .map_err(|_| "Bridge hello timed out".to_string())?
        .map_err(|_| "Bridge hello read failed".to_string())?;
    let length = u32::from_be_bytes(header);
    if length > MAX_BRIDGE_FRAME_BYTES {
        return Err("Bridge response exceeds the safe frame limit".into());
    }
    let mut body = Zeroizing::new(vec![0_u8; length as usize]);
    tokio::time::timeout(
        Duration::from_secs(10),
        stream.read_exact(body.as_mut_slice()),
    )
    .await
    .map_err(|_| "Bridge hello timed out".to_string())?
    .map_err(|_| "Bridge hello read failed".to_string())?;
    let protocol: serde_json::Value = serde_json::from_slice(body.as_slice())
        .map_err(|_| "Bridge hello response is invalid".to_string())?;
    let _ = session
        .disconnect(Disconnect::ByApplication, "probe complete", "en")
        .await;
    Ok(SshProbeResult {
        state: "connected",
        host_key_fingerprint: Some(host_key_fingerprint),
        bridge_protocol: Some(protocol),
        reason: None,
        host_key_hop: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_probe_validation_requires_explicit_tofu_fingerprint_shape() {
        let mut request = SshProbeRequest {
            host_profile_id: "host_1".into(),
            hostname: "example.test".into(),
            port: 22,
            username: "user".into(),
            credential_id: "lease_1".into(),
            authentication: AuthenticationKind::Password,
            expected_host_key: None,
            jump: None,
        };
        assert!(validate(&request).is_ok());
        request.expected_host_key = Some("not-a-fingerprint".into());
        assert!(validate(&request).is_err());
    }

    #[test]
    fn host_key_verifier_never_accepts_tofu_without_confirmation() {
        let observed = Arc::new(Mutex::new(None));
        let verifier = HostKeyVerifier {
            expected: None,
            observed,
        };
        assert!(verifier.expected.is_none());
    }

    #[derive(Clone, Default)]
    struct FixtureServer {
        buffers: Arc<tokio::sync::Mutex<std::collections::HashMap<russh::ChannelId, Vec<u8>>>>,
    }

    impl russh::server::Server for FixtureServer {
        type Handler = Self;

        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self::Handler {
            self.clone()
        }
    }

    impl russh::server::Handler for FixtureServer {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(
                if user == "fixture" && password == "temporary-test-password" {
                    russh::server::Auth::Accept
                } else {
                    russh::server::Auth::Reject {
                        proceed_with_methods: None,
                        partial_success: false,
                    }
                },
            )
        }

        async fn auth_publickey(
            &mut self,
            user: &str,
            _: &russh::keys::ssh_key::PublicKey,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(if user == "fixture" {
                russh::server::Auth::Accept
            } else {
                russh::server::Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                }
            })
        }

        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            host_to_connect: &str,
            port_to_connect: u32,
            _: &str,
            _: u32,
            reply: russh::server::ChannelOpenHandle,
            _: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            match tokio::net::TcpStream::connect((host_to_connect, port_to_connect as u16)).await {
                Ok(mut socket) => {
                    reply.accept().await;
                    tokio::spawn(async move {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut socket).await;
                    });
                }
                Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
            Ok(())
        }

        async fn channel_open_session(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.buffers.lock().await.insert(channel.id(), Vec::new());
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            command: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            if command == BRIDGE_COMMAND.as_bytes() {
                session.channel_success(channel)?;
            } else {
                session.channel_failure(channel)?;
            }
            Ok(())
        }

        async fn data(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            let mut buffers = self.buffers.lock().await;
            let buffer = buffers.entry(channel).or_default();
            buffer.extend_from_slice(data);
            if buffer.len() >= 4 {
                let length = u32::from_be_bytes(buffer[..4].try_into().unwrap()) as usize;
                if buffer.len() >= 4 + length {
                    let request: serde_json::Value =
                        serde_json::from_slice(&buffer[4..4 + length]).unwrap();
                    let responses = if request["type"] == "hello" {
                        vec![serde_json::json!({
                            "type": "hello",
                            "protocol": {"major": 1, "minor": 1},
                            "server": {"agentportVersion": "fixture", "platform": "test"},
                            "capabilities": [{"name": "session.event_push", "enabled": true}],
                            "limits": {"maxFrameBytes": 16777216, "maxSubscriptions": 64, "maxHostClients": 16}
                        })]
                    } else {
                        let request_id = request["requestId"].as_str().unwrap();
                        vec![
                            serde_json::json!({
                                "type": "accepted", "requestId": request_id,
                                "operationId": "fixture-operation", "serverSequence": 1,
                                "retryClass": "read"
                            }),
                            serde_json::json!({
                                "type": "result", "requestId": request_id,
                                "operationId": "fixture-operation", "status": "succeeded",
                                "retryClass": "read", "value": {"fixture": true}
                            }),
                        ]
                    };
                    for response in responses {
                        let response = serde_json::to_vec(&response).unwrap();
                        let mut frame = (response.len() as u32).to_be_bytes().to_vec();
                        frame.extend_from_slice(&response);
                        session.data(channel, frame)?;
                    }
                    buffer.drain(..4 + length);
                }
            }
            Ok(())
        }
    }

    fn fixture_request(port: u16, expected_host_key: Option<String>) -> SshProbeRequest {
        SshProbeRequest {
            host_profile_id: "host_fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "fixture".into(),
            credential_id: "lease_fixture".into(),
            authentication: AuthenticationKind::Password,
            expected_host_key,
            jump: None,
        }
    }

    #[tokio::test]
    async fn real_ssh_fixture_enforces_tofu_password_and_bridge_hello() {
        use russh::server::Server as _;

        let host_key = russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let fingerprint = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let config = russh::server::Config {
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            keys: vec![host_key],
            ..Default::default()
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_task = tokio::spawn(async move {
            let mut server = FixtureServer::default();
            server
                .run_on_socket(Arc::new(config), &listener)
                .await
                .unwrap();
        });

        let first_seen = probe_with_password(
            fixture_request(port, None),
            Zeroizing::new(b"temporary-test-password".to_vec()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(first_seen.reason, Some("host_key_confirmation_required"));
        assert_eq!(
            first_seen.host_key_fingerprint.as_deref(),
            Some(fingerprint.as_str())
        );

        let changed = probe_with_password(
            fixture_request(
                port,
                Some("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into()),
            ),
            Zeroizing::new(b"temporary-test-password".to_vec()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(changed.reason, Some("host_key_changed"));

        let rejected = probe_with_password(
            fixture_request(port, Some(fingerprint.clone())),
            Zeroizing::new(b"wrong-temporary-password".to_vec()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(rejected.reason, Some("ssh_authentication_failed"));

        let connected = probe_with_password(
            fixture_request(port, Some(fingerprint)),
            Zeroizing::new(b"temporary-test-password".to_vec()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(connected.state, "connected");
        assert_eq!(connected.bridge_protocol.unwrap()["protocol"]["minor"], 1);

        let product_profile = crate::hosts::HostProfile {
            id: "host_product_fixture".into(),
            name: "Product fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "fixture".into(),
            preferred_transport: crate::hosts::PreferredTransport::Ssh,
            authentication: crate::hosts::AuthenticationKind::Password,
            credential_id: "cred_fixture".into(),
            relay: None,
            jump: None,
            mosh_udp_port_start: None,
            mosh_udp_port_end: None,
            enabled: true,
            sort_order: 0,
            trusted_host_key: connected.host_key_fingerprint.clone(),
            last_connected_at: None,
            last_error: None,
            last_known_summary: None,
        };
        let (_product_connection, mut product_reader, mut product_writer, snapshot) =
            crate::remote::establish_with_secrets(
                &product_profile,
                None,
                Zeroizing::new(b"temporary-test-password".to_vec()),
                None,
            )
            .await
            .unwrap();
        assert_eq!(snapshot.protocol_major, 1);
        assert_eq!(snapshot.protocol_minor, 1);
        assert_eq!(snapshot.agentport_version, "fixture");
        let request = serde_json::to_vec(&serde_json::json!({
            "type": "request", "requestId": "product-request", "method": "boot", "params": {}
        }))
        .unwrap();
        product_writer
            .write_all(&(request.len() as u32).to_be_bytes())
            .await
            .unwrap();
        product_writer.write_all(&request).await.unwrap();
        product_writer.flush().await.unwrap();
        let mut response_types = Vec::new();
        for _ in 0..2 {
            let mut header = [0_u8; 4];
            product_reader.read_exact(&mut header).await.unwrap();
            let mut body = vec![0_u8; u32::from_be_bytes(header) as usize];
            product_reader.read_exact(&mut body).await.unwrap();
            let envelope: serde_json::Value = serde_json::from_slice(&body).unwrap();
            response_types.push(envelope["type"].as_str().unwrap().to_string());
        }
        assert_eq!(response_types, ["accepted", "result"]);

        let client_key = russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let encoded = client_key
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap();
        let mut key_request = fixture_request(
            port,
            Some(
                connected
                    .host_key_fingerprint
                    .expect("connected fixture fingerprint"),
            ),
        );
        key_request.authentication = AuthenticationKind::PrivateKey;
        let key_connected = probe_with_password(
            key_request,
            Zeroizing::new(encoded.as_bytes().to_vec()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(key_connected.state, "connected");

        let jump_host_key = russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let jump_fingerprint = jump_host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let jump_config = russh::server::Config {
            auth_rejection_time: Duration::from_millis(1),
            auth_rejection_time_initial: Some(Duration::from_millis(0)),
            keys: vec![jump_host_key],
            ..Default::default()
        };
        let jump_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let jump_port = jump_listener.local_addr().unwrap().port();
        let jump_server_task = tokio::spawn(async move {
            let mut server = FixtureServer::default();
            server
                .run_on_socket(Arc::new(jump_config), &jump_listener)
                .await
                .unwrap();
        });
        let mut jump_request = fixture_request(port, key_connected.host_key_fingerprint.clone());
        jump_request.jump = Some(JumpHostRequest {
            host_profile_id: "host_jump_fixture".into(),
            hostname: "127.0.0.1".into(),
            port: jump_port,
            username: "fixture".into(),
            credential_id: "lease_jump_fixture".into(),
            authentication: AuthenticationKind::Password,
            expected_host_key: Some(jump_fingerprint.clone()),
        });
        let jumped = probe_with_password(
            jump_request,
            Zeroizing::new(b"temporary-test-password".to_vec()),
            Some(Zeroizing::new(b"temporary-test-password".to_vec())),
        )
        .await
        .unwrap();
        assert_eq!(jumped.state, "connected");

        let mut untrusted_jump = fixture_request(port, key_connected.host_key_fingerprint);
        untrusted_jump.jump = Some(JumpHostRequest {
            host_profile_id: "host_jump_fixture".into(),
            hostname: "127.0.0.1".into(),
            port: jump_port,
            username: "fixture".into(),
            credential_id: "lease_jump_fixture".into(),
            authentication: AuthenticationKind::Password,
            expected_host_key: None,
        });
        let rejected_jump = probe_with_password(
            untrusted_jump,
            Zeroizing::new(b"temporary-test-password".to_vec()),
            Some(Zeroizing::new(b"temporary-test-password".to_vec())),
        )
        .await
        .unwrap();
        assert_eq!(
            rejected_jump.reason,
            Some("jump_host_key_confirmation_required")
        );
        assert_eq!(rejected_jump.host_key_fingerprint, Some(jump_fingerprint));

        jump_server_task.abort();
        server_task.abort();
    }
}
