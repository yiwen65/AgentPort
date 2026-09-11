use super::*;
use agentport_relay::{
    crypto::Handshake,
    net::{self, SecureChannel},
    protocol::{encode, Control},
    server,
};

#[tokio::test]
async fn native_relay_bridge_hello_and_owner_cancellation_do_not_need_ssh() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/v1/relay", listener.local_addr().unwrap());
    let (stop, stopped) = oneshot::channel();
    let server = tokio::spawn(async move {
        server::serve(
            listener,
            server::Config::new("isolated-native-relay-token").unwrap(),
            async {
                let _ = stopped.await;
            },
        )
        .await
        .unwrap();
    });
    let computer = Identity::generate().unwrap();
    let phone = Identity::generate().unwrap();
    let peer = computer
        .peer(url.clone(), "Isolated computer".into())
        .unwrap();
    let mut control = net::register_host(&url, &computer, "isolated-native-relay-token")
        .await
        .unwrap();
    let mut profile: HostProfile = serde_json::from_value(json!({
        "id":"host_relay_fixture", "name":"Fixture", "hostname":url, "port":443,"username":"",
        "preferredTransport":"relay", "authentication":"private_key", "credentialId":"cred_fixture",
        "enabled":true,"sortOrder":0,
        "relay":{"peer":peer,"devicePublicKey":phone.public_key(),"approved":true}
    }))
    .unwrap();
    // Native pin/key mismatch fails before any network request.
    let wrong = Identity::generate().unwrap();
    let Err(error) =
        establish_relay_with_secret(&profile, Zeroizing::new(wrong.private_bytes().to_vec())).await
    else {
        panic!("wrong key accepted")
    };
    assert_eq!(error.code, "relay_authentication_failed");
    assert!(!retryable_connect_error(&error));
    let allowed = phone.public_key();
    let host_peer = peer.clone();
    let host = tokio::spawn(async move {
        // First connection approved, second explicitly revoked/denied.
        for accepted in [true, false] {
            let Control::Incoming { connection_id, .. } =
                net::receive_json(&mut control).await.unwrap()
            else {
                panic!("incoming")
            };
            let mut socket = net::accept_connection(&url, &computer, &connection_id)
                .await
                .unwrap();
            let mut noise = Handshake::session(&computer, &host_peer, false).unwrap();
            noise
                .read(&net::receive_packet(&mut socket).await.unwrap())
                .unwrap();
            assert_eq!(encode(&noise.remote_key().unwrap()), allowed);
            net::send_packet(
                &mut socket,
                noise
                    .write(if accepted { b"accepted" } else { b"denied" })
                    .unwrap(),
            )
            .await
            .unwrap();
            if !accepted {
                continue;
            }
            let mut stream = SecureChannel::new(socket, noise.finish().unwrap()).into_stream();
            let hello = read_frame(&mut stream).await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&hello).unwrap()["type"],
                "hello"
            );
            write_frame(&mut stream, &json!({"type":"hello","protocol":{"major":1,"minor":1},"server":{"agentportVersion":"native-relay-fixture","platform":"isolated"},"capabilities":[],"limits":{"maxFrameBytes":16777216,"maxSubscriptions":32,"maxHostClients":32}})).await.unwrap();
            let message = read_frame(&mut stream).await.unwrap().unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&message).unwrap()["method"],
                "session.list"
            );
            write_frame(&mut stream, &json!({"type":"result","requestId":"read-only","status":"succeeded","retryClass":"read_only","value":[]})).await.unwrap();
            assert!(
                read_frame(&mut stream).await.unwrap().is_none(),
                "native owner cancellation must close despite retained split halves"
            );
        }
    });
    let (transport, mut reader, mut writer, snapshot) =
        establish_relay_with_secret(&profile, Zeroizing::new(phone.private_bytes().to_vec()))
            .await
            .unwrap();
    assert_eq!(snapshot.agentport_version, "native-relay-fixture");
    write_frame(
        &mut writer,
        &json!({"type":"request","requestId":"read-only","method":"session.list","params":{}}),
    )
    .await
    .unwrap();
    let response = read_frame(&mut reader).await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&response).unwrap()["value"],
        json!([])
    );
    drop(transport); // Reader and writer intentionally stay alive.
    assert!(
        tokio::time::timeout(Duration::from_secs(2), read_frame(&mut reader))
            .await
            .unwrap()
            .unwrap()
            .is_none()
    );
    let Err(error) =
        establish_relay_with_secret(&profile, Zeroizing::new(phone.private_bytes().to_vec())).await
    else {
        panic!("revoked key accepted")
    };
    assert_eq!(error.code, "relay_authentication_failed");
    assert!(!retryable_connect_error(&error));
    profile.relay.as_mut().unwrap().approved = false;
    assert!(
        establish_relay_with_secret(&profile, Zeroizing::new(phone.private_bytes().to_vec()))
            .await
            .is_err()
    );
    host.await.unwrap();
    stop.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn image_upload_native_sender_preserves_raw_bytes_and_generation() {
    use sha2::{Digest, Sha256};
    let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
    let state = RemoteConnections::default();
    let (client, mut server) = tokio::io::duplex(256 * 1024);
    let writer: Arc<AsyncMutex<Box<dyn AsyncWrite + Send + Unpin>>> = Arc::new(AsyncMutex::new(Box::new(client)));
    let pending = Arc::new(Mutex::new(HashMap::new()));
    let lease = tokio::spawn(std::future::pending::<()>());
    let snapshot = ConnectionSnapshot { profile_id: "image-fixture".into(), protocol_major: 1, protocol_minor: 1, agentport_version: "fixture".into(), platform: "test".into(), capabilities: vec![] };
    state.inner.connections.lock().await.insert("image-fixture".into(), Connection { generation:"image-generation".into(), snapshot, writer:writer.clone(), pending:pending.clone(), transport:Transport::Relay(RelayLease(lease.abort_handle())) });
    assert!(state.image_upload_connection("image-fixture").await.err().unwrap().contains("Update"));
    state.inner.connections.lock().await.get_mut("image-fixture").unwrap().snapshot.capabilities.push(json!({"name":"image.upload_v1","enabled":true}));
    let (_, ImageUploadConnection::Relay(relay)) = state.image_upload_connection("image-fixture").await.unwrap() else { panic!("expected Relay"); };
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec(); bytes.extend((0..150_000).map(|n| (n % 256) as u8));
    let expected = bytes.clone();
    let response_pending = pending.clone();
    let worker = tokio::spawn(async move {
        let mut received = Vec::new();
        loop {
            let frame = read_frame(&mut server).await.unwrap().unwrap();
            let (header, bytes) = if frame[0] == 0 { agentport_remote_protocol::image::decode_chunk(&frame).unwrap() } else { (&frame[..], &[][..]) };
            let request: Value = serde_json::from_slice(header).unwrap();
            let method = request["method"].as_str().unwrap();
            let response = match method {
                "image.begin" => { assert_eq!(request["params"]["size"], expected.len()); json!({"uploadId":"test-image"}) },
                "image.chunk" => { assert_eq!(request["params"]["offset"], received.len()); received.extend_from_slice(bytes); json!({"offset":received.len()}) },
                "image.finish" => { assert_eq!(received, expected); assert_eq!(request["params"]["sha256"], format!("{:x}", Sha256::digest(&received))); json!({"path":"/home/fixture/.cache/agentport/image-test.png"}) },
                _ => panic!("unexpected image method"),
            };
            response_pending.lock().unwrap().remove(request["requestId"].as_str().unwrap()).unwrap().response.send(Ok(response)).unwrap();
            if method == "image.finish" { break; }
        }
    });
    let path = std::env::temp_dir().join(format!("agentport-relay-image-native-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).unwrap();
    let result = crate::sftp::image::upload_relay_image(app.handle(), &state, "image-fixture", &relay, &path).await.unwrap();
    assert_eq!(result, "/home/fixture/.cache/agentport/image-test.png");
    worker.await.unwrap();
    state.inner.connections.lock().await.remove("image-fixture");
    assert!(relay.request(app.handle(), &state, "image-fixture", "image.begin", json!({}), None).await.unwrap_err().contains("changed"));
    assert!(pending.lock().unwrap().is_empty());
    std::fs::remove_file(path).unwrap();
}

#[test]
fn relay_authentication_and_identity_failures_never_enter_availability_retry() {
    for error in [
        agentport_relay::Error::Unauthorized,
        agentport_relay::Error::Protocol,
        agentport_relay::Error::Credential,
    ] {
        assert!(!retryable_connect_error(&relay_error(error)));
    }
    for error in [
        agentport_relay::Error::Offline,
        agentport_relay::Error::Timeout,
        agentport_relay::Error::Busy,
    ] {
        assert!(retryable_connect_error(&relay_error(error)));
    }
}
