//! End-to-end relay tests over an in-process relay server, a real connector
//! Runtime (with an in-memory vault) and the real protocol bridge — no
//! external network, no sshd. Mirrors the production pairing + session path:
//! invite → redeem → Noise session → remote-protocol hello → requests.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;

use agentport_core::paths::AppPaths;
use agentport_relay::connector::{self, Phase, Store, Vault};
use agentport_relay::crypto::Identity;
use agentport_relay::{protocol::Peer, server};
use zeroize::Zeroizing;

use crate::remote::identity::ClientIdentityStore;
use crate::remote::manager::{DeviceConnectionInfo, DeviceResolver, RemoteConnectionManager};
use crate::remote::types::DeviceProfile;
use crate::remote::{pairing, relay, RemoteCommandError};

const TOKEN: &str = "isolated-connector-registration-token";

#[derive(Default)]
struct MemoryVault(SyncMutex<HashMap<String, Zeroizing<Vec<u8>>>>);

impl Vault for MemoryVault {
    fn load(&self, account: &str) -> agentport_relay::Result<Zeroizing<Vec<u8>>> {
        self.0
            .lock()
            .unwrap()
            .get(account)
            .cloned()
            .ok_or(agentport_relay::Error::Credential)
    }

    fn create(&self, secret: &[u8]) -> agentport_relay::Result<String> {
        let id = agentport_relay::protocol::identifier()?;
        self.0
            .lock()
            .unwrap()
            .insert(id.clone(), Zeroizing::new(secret.to_vec()));
        Ok(id)
    }
}

/// The connector spawns its bridge as a subprocess; this script pumps the
/// child's stdio to a unix socket where the test runs the REAL protocol
/// bridge in-process (`agentport_remote_bridge::serve`). Input MUST use
/// os.read: BufferedReader.read(n) blocks until n bytes or EOF, which would
/// strand every partial frame in the pump thread.
const BRIDGE_PUMP: &str = r#"import socket,os,threading
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.connect("__SOCK__")
def pump():
    while True:
        d=os.read(0,65536)
        if not d: break
        s.sendall(d)
    try: s.shutdown(socket.SHUT_WR)
    except OSError: pass
threading.Thread(target=pump,daemon=True).start()
while True:
    d=s.recv(65536)
    if not d: break
    os.write(1,d)
"#;

struct RelayFixture {
    temp: tempfile::TempDir,
    url: String,
    connector: Arc<connector::Runtime>,
    connector_task: tokio::task::JoinHandle<()>,
    relay_stop: Option<tokio::sync::oneshot::Sender<()>>,
    relay_task: tokio::task::JoinHandle<()>,
    bridge_socket: PathBuf,
}

impl RelayFixture {
    async fn start() -> Self {
        // /tmp keeps unix socket paths below Darwin's 104-byte limit.
        let temp = tempfile::tempdir_in("/tmp").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/relay", listener.local_addr().unwrap());
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let relay_task = tokio::spawn(async move {
            server::serve(listener, server::Config::new(TOKEN).unwrap(), async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });

        let bridge_socket = temp.path().join("bridge.sock");
        let script = BRIDGE_PUMP.replace("__SOCK__", bridge_socket.to_str().unwrap());
        let bridge = temp.path().join("bridge-fixture");
        std::fs::write(
            &bridge,
            format!("#!/bin/sh\nexec python3 -c '\n{script}'\n"),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bridge, std::fs::Permissions::from_mode(0o700)).unwrap();
        }

        let store = Store::open(&temp.path().join("state")).unwrap();
        let connector = connector::Runtime::open(
            store,
            Arc::new(MemoryVault::default()),
            bridge,
            temp.path().join("bridge-data"),
            Some(temp.path().join("host-sockets")),
        )
        .await
        .unwrap();
        let connector_task = tokio::spawn(connector.clone().run());
        connector
            .configure(
                url.clone(),
                "Fixture computer".into(),
                Zeroizing::new(TOKEN.to_string()),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if connector.status().await.phase == Phase::Connected {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("connector must reach the relay");
        Self {
            temp,
            url,
            connector,
            connector_task,
            relay_stop: Some(stop),
            relay_task,
            bridge_socket,
        }
    }

    /// Pairs a fresh client identity and returns its DeviceProfile.
    async fn pair(&self, identity: &Identity) -> DeviceProfile {
        let invitation = self.connector.invite_automatic().await.unwrap();
        let payload = serde_json::to_string(&invitation).unwrap();
        pairing::redeem_pairing(identity, &payload, None)
            .await
            .unwrap()
    }

    async fn shutdown(mut self) {
        self.connector.stop().await;
        self.connector_task.await.unwrap();
        self.relay_stop.take().unwrap().send(()).unwrap();
        self.relay_task.await.unwrap();
    }
}

/// Runs the real protocol bridge in-process once the connector's pump script
/// connects to `socket_path`; returns the serve CloseReason over the channel.
fn serve_bridge_once(
    socket_path: &Path,
    service_root: &Path,
) -> std::sync::mpsc::Receiver<agentport_remote_bridge::CloseReason> {
    let listener = std::os::unix::net::UnixListener::bind(socket_path).unwrap();
    let service =
        agentport_service::CoreService::open(AppPaths::new(service_root.to_path_buf())).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut reader = stream.try_clone().unwrap();
        let mut writer = stream;
        let mut diagnostics = Vec::new();
        let result =
            agentport_remote_bridge::serve(&mut reader, &mut writer, &mut diagnostics, &service);
        let _ = tx.send(result.unwrap());
    });
    rx
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn redeem_pairs_profile_and_consumes_invitation() {
    let fixture = RelayFixture::start().await;
    let client_dir = tempfile::tempdir().unwrap();
    let identity_store =
        ClientIdentityStore::new(client_dir.path().join("devices").join("identity.json"));
    let identity = identity_store.identity().unwrap();

    let invitation = fixture.connector.invite_automatic().await.unwrap();
    let payload = serde_json::to_string(&invitation).unwrap();
    let profile = pairing::redeem_pairing(identity.as_ref(), &payload, None)
        .await
        .unwrap();

    assert!(profile.id.starts_with("dev_"));
    assert_eq!(profile.name, "Fixture computer");
    match &profile.transport {
        crate::remote::types::DeviceTransportProfile::Relay { peer } => {
            assert_eq!(peer.public_key, invitation.peer.public_key);
            assert_eq!(peer.host_id, invitation.peer.host_id);
            assert_eq!(peer.relay_url, fixture.url);
        }
        _ => panic!("redeemed profile must use the relay transport"),
    }
    // Identity was durable BEFORE the handshake and survives reload.
    let reloaded =
        ClientIdentityStore::new(client_dir.path().join("devices").join("identity.json"));
    assert_eq!(
        reloaded.identity().unwrap().public_key(),
        identity.public_key()
    );

    // The one-time bearer is consumed: a second holder of the same payload is
    // denied. Surfaces observed: handshake refusal (pairing_unauthorized),
    // dropped socket (relay_unreachable), or a join that can no longer be
    // routed to the consumed invitation's listener (relay_timeout). The relay
    // crate's own tests likewise only pin `is_err` for replays.
    let other = Identity::generate().unwrap();
    let error = pairing::redeem_pairing(&other, &payload, None)
        .await
        .unwrap_err();
    assert!(
        [
            "pairing_unauthorized",
            "pairing_rejected",
            "relay_unreachable",
            "relay_timeout"
        ]
        .contains(&error.code.as_str()),
        "redeeming a consumed payload must fail with a rejection code, got {error:?}"
    );

    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_connects_over_relay_and_speaks_protocol() {
    let fixture = RelayFixture::start().await;
    let client_dir = tempfile::tempdir().unwrap();
    let manager =
        RemoteConnectionManager::new(&AppPaths::new(client_dir.path().join("client-root")))
            .unwrap();
    let identity = manager.identity().unwrap();
    let profile = fixture.pair(identity.as_ref()).await;

    let served = serve_bridge_once(
        &fixture.bridge_socket,
        &fixture.temp.path().join("service-root"),
    );

    struct ProfileResolver(DeviceProfile);
    impl DeviceResolver for ProfileResolver {
        fn resolve(&self, _device_id: &str) -> Result<DeviceConnectionInfo, RemoteCommandError> {
            self.0.connection_info(None)
        }
    }
    manager.set_resolver(Arc::new(ProfileResolver(profile.clone())));

    let manager = Arc::new(manager);
    let device_id = profile.id.clone();
    let hello = {
        let manager = Arc::clone(&manager);
        let device_id = device_id.clone();
        tokio::task::spawn_blocking(move || manager.connect(&device_id))
            .await
            .unwrap()
            .unwrap()
    };
    assert_eq!(hello.device_name, "Fixture computer");
    assert!(
        hello
            .capabilities
            .iter()
            .any(|name| name == agentport_remote_protocol::CAPABILITY_SESSION_EVENT_PUSH),
        "bridge must grant event push: {:?}",
        hello.capabilities
    );

    let sessions = {
        let manager = Arc::clone(&manager);
        tokio::task::spawn_blocking(move || {
            manager.request(&device_id, "session.list", serde_json::json!({}))
        })
        .await
        .unwrap()
        .unwrap()
    };
    assert_eq!(sessions, serde_json::json!([]));

    drop(manager);
    let close = served
        .recv_timeout(Duration::from_secs(15))
        .expect("bridge must exit after the client disconnects");
    assert_eq!(close, agentport_remote_bridge::CloseReason::EndOfInput);
    fixture.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unpaired_identity_cannot_open_a_session() {
    let fixture = RelayFixture::start().await;
    let invitation = fixture.connector.invite_automatic().await.unwrap();
    let peer: Peer = invitation.peer.clone();
    // Never paired: session handshake must fail with an authorization error.
    let stranger = Arc::new(Identity::generate().unwrap());
    let result = {
        let peer = peer.clone();
        tokio::task::spawn_blocking(move || {
            relay::connect(&peer, stranger, Duration::from_secs(10))
        })
        .await
        .unwrap()
    };
    let error = result.err().expect("unpaired connect must fail");
    // Denied during the Noise session handshake or via a dropped socket.
    assert!(
        ["pairing_unauthorized", "relay_unreachable"].contains(&error.code.as_str()),
        "unpaired session must fail with a rejection code, got {error:?}"
    );
    fixture.shutdown().await;
}
