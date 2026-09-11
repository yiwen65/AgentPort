use super::*;
use crate::{
    endpoint::{connect_session, connect_session_realtime, PairingConnection},
    server,
};
use std::{fs, os::unix::fs::PermissionsExt, sync::Mutex as SyncMutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const TOKEN: &str = "isolated-connector-registration-token";
#[derive(Default)]
struct MemoryVault(SyncMutex<HashMap<String, Zeroizing<Vec<u8>>>>);
impl Vault for MemoryVault {
    fn load(&self, account: &str) -> Result<Zeroizing<Vec<u8>>> {
        self.0
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .ok_or(Error::Credential)
    }
    fn create(&self, secret: &[u8]) -> Result<String> {
        let id = identifier()?;
        self.0
            .lock()
            .unwrap()
            .insert(id.clone(), Zeroizing::new(secret.to_vec()));
        Ok(id)
    }
}
struct Fixture {
    temp: tempfile::TempDir,
    runtime: Arc<Runtime>,
    run: JoinHandle<()>,
    vault: Arc<MemoryVault>,
    relay: JoinHandle<()>,
    relay_stop: Option<tokio::sync::oneshot::Sender<()>>,
    url: String,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_bridge(None).await
    }
    async fn with_bridge(real_bridge: Option<PathBuf>) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/relay", listener.local_addr().unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let relay = tokio::spawn(async move {
            server::serve(listener, server::Config::new(TOKEN).unwrap(), async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        // Dedicated fixture subprocess only; never attach to a real user Session.
        let bridge = temp.path().join("bridge-fixture");
        fs::write(
            &bridge,
            format!(
                "#!/bin/sh\nprintf 'started\\n' >> '{}'\nexec /bin/cat\n",
                temp.path().join("spawns").display()
            ),
        )
        .unwrap();
        if let Some(real_bridge) = real_bridge {
            fs::write(&bridge, format!("#!/bin/sh\nexport HOME='{}'\nexec '{}' \"$@\"\n", temp.path().display(), real_bridge.display().to_string().replace('\'', "'\"'\"'"))).unwrap();
        }
        fs::set_permissions(&bridge, fs::Permissions::from_mode(0o700)).unwrap();
        let vault = Arc::new(MemoryVault::default());
        let runtime = Runtime::open(
            Store::open(&temp.path().join("state")).unwrap(),
            vault.clone(),
            bridge,
            temp.path().to_path_buf(),
            Some(temp.path().join("host-sockets")),
        )
        .await
        .unwrap();
        let run = tokio::spawn(runtime.clone().run());
        runtime
            .configure(
                url.clone(),
                "Isolated computer".into(),
                Zeroizing::new(TOKEN.into()),
            )
            .await
            .unwrap();
        wait_connected(&runtime).await;
        Self {
            temp,
            runtime,
            run,
            vault,
            relay,
            relay_stop: Some(stop),
            url,
        }
    }
    fn spawns(&self) -> usize {
        fs::read_to_string(self.temp.path().join("spawns"))
            .unwrap_or_default()
            .lines()
            .count()
    }
    async fn shutdown(mut self) {
        self.runtime.stop().await;
        self.run.await.unwrap();
        self.relay_stop.take().unwrap().send(()).unwrap();
        self.relay.await.unwrap();
    }
}
async fn wait_connected(runtime: &Runtime) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while runtime.status().await.phase != Phase::Connected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
async fn approve(runtime: &Runtime, phone: &Identity) -> Peer {
    let invitation = runtime.invite().await.unwrap();
    let pairing = PairingConnection::begin(phone, &invitation, "Isolated phone".into())
        .await
        .unwrap();
    let status = runtime.status().await.pairing.unwrap();
    let candidate = status.candidate.unwrap();
    assert_eq!(candidate.verification_code, pairing.verification_code);
    runtime
        .decide(
            &invitation.id,
            &candidate.request_id,
            &candidate.public_key,
            true,
        )
        .await
        .unwrap();
    pairing.wait().await.unwrap();
    invitation.peer.clone()
}

#[tokio::test]
async fn realtime_stream_uses_tls_only_after_device_authorization_and_remains_revocable() {
    let fixture = Fixture::new().await;
    let phone = Identity::generate().unwrap();
    let peer = approve(&fixture.runtime, &phone).await;
    let unauthorized = Identity::generate().unwrap();
    assert!(connect_session_realtime(&unauthorized, &peer)
        .await
        .is_err());
    assert_eq!(fixture.spawns(), 0);
    let stream = connect_session_realtime(&phone, &peer).await.unwrap();
    assert!(!stream.is_end_to_end_encrypted());
    let (mut reader, mut writer) = tokio::io::split(stream);
    let payload = vec![42; 256 * 1024];
    let mut received = vec![0; payload.len()];
    tokio::time::timeout(Duration::from_secs(3), async {
        let (sent, read) = tokio::join!(
            async {
                writer.write_all(&payload).await?;
                writer.flush().await
            },
            reader.read_exact(&mut received),
        );
        sent.unwrap();
        read.unwrap();
    })
    .await
    .unwrap();
    assert_eq!(received, payload);
    fixture.runtime.revoke(&phone.public_key()).await.unwrap();
    assert!(connect_session_realtime(&phone, &peer).await.is_err());
    assert_eq!(fixture.runtime.status().await.active_channels, 0);
    fixture.shutdown().await;
}

#[tokio::test]
async fn automatic_qr_grants_only_first_authenticated_holder_and_remains_revocable() {
    let fixture = Fixture::new().await;
    let phone = Identity::generate().unwrap();
    let other = Identity::generate().unwrap();
    let invitation = fixture.runtime.invite_automatic().await.unwrap();
    let mut wrong = invitation.clone();
    wrong.secret = Invitation::new(invitation.peer.clone())
        .unwrap()
        .secret
        .clone();
    assert!(PairingConnection::begin(&other, &wrong, "Wrong".into())
        .await
        .is_err());
    assert!(fixture.runtime.status().await.devices.is_empty());
    PairingConnection::begin(&phone, &invitation, "Phone".into())
        .await
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert_eq!(
        fixture.runtime.status().await.devices[0].public_key,
        phone.public_key()
    );
    assert!(
        PairingConnection::begin(&other, &invitation, "Replay".into())
            .await
            .is_err()
    );
    let mut channel = connect_session(&phone, &invitation.peer).await.unwrap();
    channel.write_all(b"automatic").await.unwrap();
    let mut response = [0; 9];
    channel.read_exact(&mut response).await.unwrap();
    assert_eq!(&response, b"automatic");
    fixture.runtime.revoke(&phone.public_key()).await.unwrap();
    assert!(connect_session(&phone, &invitation.peer).await.is_err());
    fixture.shutdown().await;
}

#[tokio::test]
async fn automatic_qr_never_reports_approval_when_storage_fails() {
    let fixture = Fixture::new().await;
    let invitation = fixture.runtime.invite_automatic().await.unwrap();
    fs::set_permissions(
        fixture.temp.path().join("state/state.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(
        PairingConnection::begin(&Identity::generate().unwrap(), &invitation, "Phone".into())
            .await
            .is_err()
    );
    assert!(fixture.runtime.status().await.devices.is_empty());
    assert_eq!(fixture.runtime.status().await.phase, Phase::StorageFailed);
    fixture.shutdown().await;
}

#[tokio::test]
async fn approval_is_exact_durable_one_time_and_revocation_closes_all_device_channels() {
    let fixture = Fixture::new().await;
    let phone = Identity::generate().unwrap();
    let other = Identity::generate().unwrap();
    let invitation = fixture.runtime.invite().await.unwrap();
    assert!(matches!(
        connect_session(&phone, &invitation.peer).await,
        Err(Error::Unauthorized)
    ));
    assert_eq!(fixture.spawns(), 0);
    let pairing = PairingConnection::begin(&phone, &invitation, "Phone one".into())
        .await
        .unwrap();
    let candidate = fixture
        .runtime
        .status()
        .await
        .pairing
        .unwrap()
        .candidate
        .unwrap();
    assert_eq!(candidate.verification_code, pairing.verification_code);
    assert!(fixture
        .runtime
        .decide(
            &invitation.id,
            &identifier().unwrap(),
            &candidate.public_key,
            true
        )
        .await
        .is_err());
    assert!(fixture
        .runtime
        .decide(
            &invitation.id,
            &candidate.request_id,
            &other.public_key(),
            true
        )
        .await
        .is_err());
    assert!(fixture.runtime.status().await.devices.is_empty());
    fixture
        .runtime
        .decide(
            &invitation.id,
            &candidate.request_id,
            &candidate.public_key,
            true,
        )
        .await
        .unwrap();
    pairing.wait().await.unwrap();
    let persisted: Persistent = fixture.runtime.store.read().unwrap().unwrap();
    assert_eq!(persisted.devices[0].public_key, phone.public_key());
    // Same invitation cannot claim a second device after approval.
    assert!(tokio::time::timeout(
        Duration::from_millis(500),
        PairingConnection::begin(&other, &invitation, "Other".into())
    )
    .await
    .is_err());
    assert!(fixture
        .runtime
        .decide(
            &invitation.id,
            &candidate.request_id,
            &candidate.public_key,
            true
        )
        .await
        .is_err());
    let mut a = connect_session(&phone, &invitation.peer).await.unwrap();
    let mut b = connect_session(&phone, &invitation.peer).await.unwrap();
    a.write_all(b"terminal fixture").await.unwrap();
    let mut echoed = [0; 16];
    a.read_exact(&mut echoed).await.unwrap();
    assert_eq!(&echoed, b"terminal fixture");
    b.write_all(b"second").await.unwrap();
    let mut reply = [0; 6];
    b.read_exact(&mut reply).await.unwrap();
    assert_eq!(fixture.spawns(), 2);
    let other_peer = approve(&fixture.runtime, &other).await;
    let mut unaffected = connect_session(&other, &other_peer).await.unwrap();
    unaffected.write_all(b"other").await.unwrap();
    let mut other_reply = [0; 5];
    unaffected.read_exact(&mut other_reply).await.unwrap();
    assert_eq!(fixture.spawns(), 3);
    fixture.runtime.revoke(&phone.public_key()).await.unwrap();
    assert_eq!(fixture.runtime.status().await.active_channels, 1);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), a.read(&mut echoed))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), b.read(&mut reply))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(matches!(
        connect_session(&phone, &invitation.peer).await,
        Err(Error::Unauthorized)
    ));
    unaffected.write_all(b"still").await.unwrap();
    unaffected.read_exact(&mut other_reply).await.unwrap();
    assert_eq!(&other_reply, b"still");
    assert_eq!(fixture.spawns(), 3);
    let persisted: Persistent = fixture.runtime.store.read().unwrap().unwrap();
    assert_eq!(persisted.devices.len(), 1);
    assert_eq!(persisted.devices[0].public_key, other.public_key());
    fixture.shutdown().await;
}

#[tokio::test]
async fn denied_expired_and_wrong_secret_pairing_never_authorize_or_spawn_bridge() {
    let fixture = Fixture::new().await;
    let phone = Identity::generate().unwrap();
    let inv = fixture.runtime.invite().await.unwrap();
    let mut wrong = inv.clone();
    wrong.secret = encode(&[7; 32]);
    assert!(PairingConnection::begin(&phone, &wrong, "Wrong PSK".into())
        .await
        .is_err());
    assert_eq!(
        fixture.runtime.status().await.pairing.unwrap().phase,
        PairPhase::Waiting
    );
    let pairing = PairingConnection::begin(&phone, &inv, "Phone".into())
        .await
        .unwrap();
    let candidate = fixture
        .runtime
        .status()
        .await
        .pairing
        .unwrap()
        .candidate
        .unwrap();
    fixture
        .runtime
        .decide(&inv.id, &candidate.request_id, &candidate.public_key, false)
        .await
        .unwrap();
    assert!(matches!(pairing.wait().await, Err(Error::Unauthorized)));
    let next = fixture.runtime.invite().await.unwrap();
    let pairing = PairingConnection::begin(&phone, &next, "Phone".into())
        .await
        .unwrap();
    {
        let mut inner = fixture.runtime.inner.lock().await;
        inner.pairing.as_mut().unwrap().invitation.expires_at = now();
    }
    assert!(fixture
        .runtime
        .decide(&next.id, &pairing.request_id, &phone.public_key(), true)
        .await
        .is_err());
    fixture.runtime.close_invitation(&next.id).await;
    assert!(pairing.wait().await.is_err());
    assert!(fixture.runtime.status().await.devices.is_empty());
    assert_eq!(fixture.spawns(), 0);
    fixture.shutdown().await;
}

#[tokio::test]
async fn disconnected_approval_retains_identity_and_restart_preserves_gate() {
    let fixture = Fixture::new().await;
    let phone = Identity::generate().unwrap();
    let invitation = fixture.runtime.invite().await.unwrap();
    let pairing = PairingConnection::begin(&phone, &invitation, "Phone".into())
        .await
        .unwrap();
    let candidate = fixture
        .runtime
        .status()
        .await
        .pairing
        .unwrap()
        .candidate
        .unwrap();
    drop(pairing); // Phone cannot observe the later result, but must retain its key.
    fixture
        .runtime
        .decide(
            &invitation.id,
            &candidate.request_id,
            &candidate.public_key,
            true,
        )
        .await
        .unwrap();
    let peer = invitation.peer.clone();
    let state = fixture.temp.path().join("state");
    let bridge = fixture.temp.path().join("bridge-fixture");
    fixture.runtime.stop().await;
    fixture.run.await.unwrap();
    drop(fixture.runtime); // Release lifetime store lock; same durable state/key vault.
    let runtime = Runtime::open(
        Store::open(&state).unwrap(),
        fixture.vault.clone(),
        bridge,
        fixture.temp.path().to_path_buf(),
        None,
    )
    .await
    .unwrap();
    let run = tokio::spawn(runtime.clone().run());
    wait_connected(&runtime).await;
    let mut channel = connect_session(&phone, &peer).await.unwrap();
    channel.write_all(b"after restart").await.unwrap();
    let mut reply = [0; 13];
    channel.read_exact(&mut reply).await.unwrap();
    assert_eq!(&reply, b"after restart");
    runtime.revoke(&phone.public_key()).await.unwrap();
    runtime.stop().await;
    run.await.unwrap();
    fixture.relay_stop.unwrap().send(()).unwrap();
    fixture.relay.await.unwrap();
}

#[tokio::test]
async fn storage_failure_never_claims_success_and_missing_key_never_rotates_identity() {
    let fixture = Fixture::new().await;
    let phone = Identity::generate().unwrap();
    let peer = approve(&fixture.runtime, &phone).await;
    let settings = fixture
        .runtime
        .inner
        .lock()
        .await
        .durable
        .settings
        .clone()
        .unwrap();
    fixture
        .vault
        .0
        .lock()
        .unwrap()
        .remove(&settings.identity_account);
    assert!(matches!(
        fixture
            .runtime
            .configure(
                fixture.url.clone(),
                "Changed".into(),
                Zeroizing::new(TOKEN.into())
            )
            .await,
        Err(Error::Credential)
    ));
    assert_eq!(
        fixture.runtime.status().await.peer.unwrap().public_key,
        peer.public_key
    );
    fs::set_permissions(
        fixture.temp.path().join("state/state.json"),
        fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(matches!(
        fixture.runtime.revoke(&phone.public_key()).await,
        Err(Error::Storage)
    ));
    assert_eq!(fixture.runtime.status().await.phase, Phase::StorageFailed);
    assert!(fixture.runtime.status().await.devices.is_empty());
    fixture.shutdown().await;
}

#[tokio::test]
async fn ipc_is_bounded_and_status_never_contains_private_credentials() {
    let fixture = Fixture::new().await;
    let directory = fixture.temp.path().join("ipc");
    private_directory(&directory).unwrap();
    let rt = fixture.runtime.clone();
    let dir = directory.clone();
    let ipc_task = tokio::spawn(async move {
        ipc::serve(&dir, rt).await.unwrap();
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !directory.join("control.sock").exists() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let response = ipc::call(&directory, &ipc::Request::Status).await.unwrap();
    let text = serde_json::to_string(&response).unwrap();
    assert!(!text.contains(TOKEN));
    assert!(!text.contains("identityAccount"));
    assert!(matches!(response, ipc::Response::Status { .. }));
    let mut raw = tokio::net::UnixStream::connect(directory.join("control.sock"))
        .await
        .unwrap();
    raw.write_u32(8193).await.unwrap();
    let mut byte = [0; 1];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), raw.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    drop(raw);
    // Losing a GUI/control socket does not own or terminate the registration.
    assert_eq!(fixture.runtime.status().await.phase, Phase::Connected);
    fixture.runtime.stop().await;
    ipc_task.await.unwrap();
    fixture.shutdown().await;
}

#[tokio::test]
#[ignore = "requires explicit AGENTPORT_RELAY_TEST_BRIDGE path to a built Bridge binary"]
async fn real_bridge_hello_and_read_only_request_traverse_relay_in_isolated_data_root() {
    let bridge = PathBuf::from(
        std::env::var_os("AGENTPORT_RELAY_TEST_BRIDGE").expect("explicit test Bridge path"),
    )
    .canonicalize()
    .unwrap();
    let fixture = Fixture::with_bridge(Some(bridge)).await;
    let phone = Identity::generate().unwrap();
    let invitation = fixture.runtime.invite_automatic().await.unwrap();
    PairingConnection::begin(&phone, &invitation, "Read-only fixture".into())
        .await
        .unwrap()
        .wait()
        .await
        .unwrap();
    let peer = invitation.peer.clone();
    let mut stream = connect_session(&phone, &peer).await.unwrap();
    async fn exchange(
        stream: &mut net::EncryptedStream,
        value: serde_json::Value,
    ) -> serde_json::Value {
        let bytes = serde_json::to_vec(&value).unwrap();
        stream.write_u32(bytes.len() as u32).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.flush().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let size = stream.read_u32().await.unwrap();
                assert!(size <= 1024 * 1024);
                let mut bytes = vec![0; size as usize];
                stream.read_exact(&mut bytes).await.unwrap();
                let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                // Bridge emits accepted before a terminal result, including reads.
                if response["type"] != "accepted" {
                    return response;
                }
                assert_eq!(response["requestId"], value["requestId"]);
            }
        })
        .await
        .unwrap()
    }
    let hello = exchange(&mut stream, serde_json::json!({"type":"hello", "protocol":{"major":1,"minor":1}, "client":{"name":"isolated-relay-check","version":"1"}, "requestedCapabilities":["session.read","image.upload_v1"]})).await;
    assert_eq!(hello["type"], "hello");
    let response = exchange(&mut stream, serde_json::json!({"type":"request", "requestId":"isolated-read", "method":"project.list", "params":{}})).await;
    assert_eq!(response["type"], "result");
    assert_eq!(response["status"], "succeeded");
    assert_eq!(response["value"], serde_json::json!([]));
    assert!(hello["capabilities"].as_array().unwrap().iter().any(|cap| cap["name"] == "image.upload_v1" && cap["enabled"] == true));
    use sha2::{Digest, Sha256};
    for extension in ["png", "jpg"] {
        let mut image = if extension == "png" { b"\x89PNG\r\n\x1a\n".to_vec() } else { vec![255, 216, 255] };
        image.extend((0..200_000).map(|n| (n % 256) as u8));
        let begin = exchange(&mut stream, serde_json::json!({"type":"request","requestId":"image-begin","method":"image.begin","params":{"size":image.len(),"extension":extension}})).await;
        assert_eq!(begin["status"], "succeeded");
        let id = begin["value"]["uploadId"].clone();
        let mut offset = 0;
        for chunk in image.chunks(agentport_remote_protocol::image::MAX_CHUNK_BYTES) {
            let header = serde_json::to_vec(&serde_json::json!({"type":"request","requestId":"image-chunk","method":"image.chunk","params":{"uploadId":id,"offset":offset}})).unwrap();
            let packet = agentport_remote_protocol::image::encode_chunk(&header, chunk).unwrap();
            stream.write_u32(packet.len() as u32).await.unwrap();
            stream.write_all(&packet).await.unwrap();
            stream.flush().await.unwrap();
            let length = stream.read_u32().await.unwrap();
            assert!(length < 4096);
            let mut response = vec![0; length as usize];
            stream.read_exact(&mut response).await.unwrap();
            let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
            offset += chunk.len();
            assert_eq!(response["status"], "succeeded");
            assert_eq!(response["value"]["offset"], offset);
            // A normal Bridge request can run between upload chunks.
            let read = exchange(&mut stream, serde_json::json!({"type":"request","requestId":"interleaved-read","method":"project.list","params":{}})).await;
            assert_eq!(read["status"], "succeeded");
        }
        let finish = exchange(&mut stream, serde_json::json!({"type":"request","requestId":"image-finish","method":"image.finish","params":{"uploadId":id,"sha256":format!("{:x}",Sha256::digest(&image))}})).await;
        assert_eq!(finish["status"], "succeeded");
        let path = PathBuf::from(finish["value"]["path"].as_str().unwrap());
        assert!(path.starts_with(fixture.temp.path()));
        assert_eq!(fs::read(&path).unwrap(), image);
    }
    fixture.runtime.revoke(&phone.public_key()).await.unwrap();
    let mut byte = [0; 1];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    fixture.shutdown().await;
}

#[tokio::test]
async fn connector_reconnects_after_relay_restart_without_changing_device_authorization() {
    let fixture = Fixture::new().await;
    let phone = Identity::generate().unwrap();
    let peer = approve(&fixture.runtime, &phone).await;
    let mut old = connect_session(&phone, &peer).await.unwrap();
    old.write_all(b"before").await.unwrap();
    let mut reply = [0; 6];
    old.read_exact(&mut reply).await.unwrap();
    fixture.relay_stop.unwrap().send(()).unwrap();
    fixture.relay.await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), old.read(&mut reply))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    let url = url::Url::parse(&fixture.url).unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", url.port().unwrap()))
        .await
        .unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        server::serve(listener, server::Config::new(TOKEN).unwrap(), async {
            let _ = stopped.await;
        })
        .await
        .unwrap();
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(mut fresh) = connect_session(&phone, &peer).await {
                fresh.write_all(b"after!").await.unwrap();
                fresh.read_exact(&mut reply).await.unwrap();
                assert_eq!(&reply, b"after!");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        fixture.runtime.status().await.devices[0].public_key,
        phone.public_key()
    );
    fixture.runtime.stop().await;
    fixture.run.await.unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}
