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
