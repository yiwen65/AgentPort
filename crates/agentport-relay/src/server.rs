//! Bounded blind routing. Registration needs a deployment token AND a fresh
//! proof of the computer's private key; terminal/session keys never reach here.
use crate::{
    crypto::Handshake,
    net::{self, Socket, HEARTBEAT, IDLE_TIMEOUT, IO_TIMEOUT},
    protocol::*,
    Error, Result,
};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use subtle::ConstantTimeEq;
use tokio::{
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot, Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        http::StatusCode,
        Message,
    },
    MaybeTlsStream,
};

#[derive(Clone)]
pub struct Config {
    token_hash: [u8; 32],
    pub max_connections: usize,
    pub max_hosts: usize,
    pub max_pending_per_host: usize,
}
impl Config {
    pub fn new(host_token: &str) -> Result<Self> {
        if !(16..=256).contains(&host_token.len()) {
            return Err(Error::Invalid(
                "host registration token must be 16-256 bytes",
            ));
        }
        Ok(Self {
            token_hash: Sha256::digest(host_token).into(),
            max_connections: 256,
            max_hosts: 64,
            max_pending_per_host: 8,
        })
    }
}
struct Host {
    generation: String,
    incoming: mpsc::Sender<Control>,
}
struct Pending {
    host_id: String,
    generation: String,
    socket: oneshot::Sender<(Socket, OwnedSemaphorePermit)>,
}
#[derive(Default)]
struct Routes {
    hosts: HashMap<String, Host>,
    pending: HashMap<String, Pending>,
}
struct State {
    config: Config,
    routes: Mutex<Routes>,
}

pub async fn serve(
    listener: TcpListener,
    config: Config,
    shutdown: impl std::future::Future<Output = ()>,
) -> Result<()> {
    if !(1..=1024).contains(&config.max_connections)
        || config.max_hosts == 0
        || config.max_hosts > config.max_connections
        || !(1..=32).contains(&config.max_pending_per_host)
    {
        return Err(Error::Invalid("relay resource limits"));
    }
    let slots = Arc::new(Semaphore::new(config.max_connections));
    let state = Arc::new(State {
        config,
        routes: Mutex::new(Routes::default()),
    });
    let mut tasks = JoinSet::new();
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            accepted = listener.accept() => {
                let (socket, _) = accepted?;
                let Ok(slot) = slots.clone().try_acquire_owned() else { drop(socket); continue; };
                let state = state.clone();
                tasks.spawn(async move { let _ = handle_socket(socket, state, slot).await; });
            }
            _ = tasks.join_next(), if !tasks.is_empty() => {},
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
// The unboxed error type is required by tungstenite's upgrade callback API.
#[allow(clippy::result_large_err)]
fn upgrade(request: &Request, response: Response) -> std::result::Result<Response, ErrorResponse> {
    if request.uri().path() != ENDPOINT
        || request.uri().query().is_some()
        || request.headers().contains_key("origin")
    {
        return Err(Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Some("Native relay endpoint required".into()))
            .expect("static HTTP response"));
    }
    Ok(response)
}
async fn reject(socket: &mut Socket, reason: Rejection) -> Result<()> {
    net::send_json(socket, &Control::Rejected { reason }).await
}
async fn prove_host(
    socket: &mut Socket,
    public_key: &str,
    connection_id: Option<&str>,
) -> Result<String> {
    let public = decode::<32>(public_key)?;
    if public == [0; 32] {
        return Err(Error::Unauthorized);
    }
    let mut noise = Handshake::registration_challenge(public_key, connection_id)?;
    net::send_packet(socket, noise.write(&[])?).await?;
    noise.read(&net::receive_packet(socket).await?)?;
    noise.finish()?;
    Ok(host_id(&public))
}
async fn handle_socket(
    socket: TcpStream,
    state: Arc<State>,
    slot: OwnedSemaphorePermit,
) -> Result<()> {
    let mut socket = net::timed(async {
        Ok(accept_hdr_async_with_config(
            MaybeTlsStream::Plain(socket),
            upgrade,
            Some(net::socket_config()),
        )
        .await?)
    })
    .await?;
    let registration: Registration = net::receive_json(&mut socket).await?;
    match registration {
        Registration::Host {
            public_key,
            access_token,
        } => {
            let digest: [u8; 32] = Sha256::digest(access_token.as_bytes()).into();
            if !bool::from(digest.ct_eq(&state.config.token_hash)) {
                reject(&mut socket, Rejection::Unauthorized).await?;
                return Err(Error::Unauthorized);
            }
            drop(access_token);
            let id = prove_host(&mut socket, &public_key, None).await?;
            host_loop(socket, state, id).await
        }
        Registration::Accept {
            public_key,
            connection_id,
        } => {
            let host = prove_host(&mut socket, &public_key, Some(&connection_id)).await?;
            let pending = {
                let mut routes = state.routes.lock().await;
                let allowed = routes.pending.get(&connection_id).is_some_and(|pending| {
                    pending.host_id == host
                        && routes
                            .hosts
                            .get(&host)
                            .is_some_and(|current| current.generation == pending.generation)
                });
                if allowed {
                    routes.pending.remove(&connection_id)
                } else {
                    None
                }
            };
            let Some(pending) = pending else {
                reject(&mut socket, Rejection::Offline).await?;
                return Err(Error::Offline);
            };
            net::send_json(&mut socket, &Control::Ready).await?;
            pending
                .socket
                .send((socket, slot))
                .map_err(|_| Error::Offline)
        }
        Registration::Join { host_id, mode } => {
            mode.context(&host_id)?;
            join_loop(socket, state, host_id, mode).await
        }
    }
}
async fn host_loop(mut socket: Socket, state: Arc<State>, id: String) -> Result<()> {
    let generation = identifier()?;
    let (tx, mut incoming) = mpsc::channel(state.config.max_pending_per_host);
    {
        let mut routes = state.routes.lock().await;
        if routes.hosts.len() >= state.config.max_hosts && !routes.hosts.contains_key(&id) {
            drop(routes);
            reject(&mut socket, Rejection::Busy).await?;
            return Err(Error::Busy);
        }
        // A new authenticated owner replaces an obsolete registration. Late
        // cleanup from the previous generation cannot remove the new route.
        routes.pending.retain(|_, pending| pending.host_id != id);
        routes.hosts.insert(
            id.clone(),
            Host {
                generation: generation.clone(),
                incoming: tx,
            },
        );
    }
    let result = async {
        net::send_json(&mut socket, &Control::Ready).await?;
        let mut heartbeat = tokio::time::interval(HEARTBEAT);
        let mut received = tokio::time::Instant::now();
        loop {
            tokio::select! {
                value = incoming.recv() => { net::send_json(&mut socket, &value.ok_or(Error::Offline)?).await?; }
                message = socket.next() => {
                    received = tokio::time::Instant::now();
                    match message.ok_or(Error::Transport)?? {
                        Message::Ping(_) => { net::timed(async { socket.flush().await?; Ok(()) }).await?; },
                        Message::Pong(_) => {},
                        Message::Close(_) => return Ok(()),
                        _ => return Err(Error::Protocol),
                    }
                }
                _ = heartbeat.tick() => {
                    if received.elapsed() > IDLE_TIMEOUT { return Err(Error::Timeout); }
                    net::timed(async { socket.send(Message::Ping(Vec::new().into())).await?; Ok(()) }).await?;
                }
            }
        }
    }.await;
    let mut routes = state.routes.lock().await;
    if routes
        .hosts
        .get(&id)
        .is_some_and(|host| host.generation == generation)
    {
        routes.hosts.remove(&id);
    }
    routes
        .pending
        .retain(|_, pending| pending.generation != generation);
    result
}
async fn join_loop(
    mut phone: Socket,
    state: Arc<State>,
    host_id: String,
    mode: Mode,
) -> Result<()> {
    let id = identifier()?;
    let receiver = {
        let mut routes = state.routes.lock().await;
        let Some(host) = routes.hosts.get(&host_id) else {
            drop(routes);
            reject(&mut phone, Rejection::Offline).await?;
            return Err(Error::Offline);
        };
        if routes
            .pending
            .values()
            .filter(|entry| entry.host_id == host_id)
            .count()
            >= state.config.max_pending_per_host
        {
            drop(routes);
            reject(&mut phone, Rejection::Busy).await?;
            return Err(Error::Busy);
        }
        let generation = host.generation.clone();
        let incoming = host.incoming.clone();
        let (sender, receiver) = oneshot::channel();
        if incoming
            .try_send(Control::Incoming {
                connection_id: id.clone(),
                mode,
            })
            .is_err()
        {
            drop(routes);
            reject(&mut phone, Rejection::Busy).await?;
            return Err(Error::Busy);
        }
        routes.pending.insert(
            id.clone(),
            Pending {
                host_id,
                generation,
                socket: sender,
            },
        );
        receiver
    };
    let accepted = tokio::time::timeout(IO_TIMEOUT, receiver).await;
    state.routes.lock().await.pending.remove(&id);
    let (computer, _computer_slot) = accepted
        .map_err(|_| Error::Timeout)?
        .map_err(|_| Error::Offline)?;
    net::send_json(&mut phone, &Control::Ready).await?;
    forward(phone, computer).await
}
async fn forward(mut a: Socket, mut b: Socket) -> Result<()> {
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    let mut a_received = tokio::time::Instant::now();
    let mut b_received = a_received;
    loop {
        tokio::select! {
            message = a.next() => {
                a_received = tokio::time::Instant::now();
                if !forward_one(message, &mut a, &mut b).await? { return Ok(()); }
            }
            message = b.next() => {
                b_received = tokio::time::Instant::now();
                if !forward_one(message, &mut b, &mut a).await? { return Ok(()); }
            }
            _ = heartbeat.tick() => {
                if a_received.elapsed() > IDLE_TIMEOUT || b_received.elapsed() > IDLE_TIMEOUT { return Err(Error::Timeout); }
                net::timed(async { a.send(Message::Ping(Vec::new().into())).await?; b.send(Message::Ping(Vec::new().into())).await?; Ok(()) }).await?;
            }
        }
    }
}
async fn forward_one(
    message: Option<std::result::Result<Message, tokio_tungstenite::tungstenite::Error>>,
    source: &mut Socket,
    target: &mut Socket,
) -> Result<bool> {
    match message.ok_or(Error::Transport)?? {
        Message::Binary(bytes) if bytes.len() <= MAX_CIPHER => {
            net::timed(async {
                target.send(Message::Binary(bytes)).await?;
                Ok(())
            })
            .await?;
        }
        Message::Ping(_) => {
            net::timed(async {
                source.flush().await?;
                Ok(())
            })
            .await?;
        }
        Message::Pong(_) => {}
        Message::Close(_) => return Ok(false),
        _ => return Err(Error::Protocol),
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        crypto::Identity,
        net::{EncryptedStream, SecureChannel},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const TOKEN: &str = "isolated-test-registration-token";
    async fn relay(config: Config) -> (String, oneshot::Sender<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/relay", listener.local_addr().unwrap());
        let (stop, stopped) = oneshot::channel();
        tokio::spawn(async move {
            serve(listener, config, async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
        });
        (url, stop)
    }
    async fn pair_sockets(url: &str, host: &Identity, control: &mut Socket) -> (Socket, Socket) {
        let peer = host.peer(url.into(), "Isolated computer".into()).unwrap();
        let phone = tokio::spawn(async move { net::join(&peer, Mode::Session).await.unwrap() });
        let Control::Incoming { connection_id, .. } = net::receive_json(control).await.unwrap()
        else {
            panic!("incoming request")
        };
        let desktop = net::accept_connection(url, host, &connection_id)
            .await
            .unwrap();
        (phone.await.unwrap(), desktop)
    }
    #[tokio::test]
    async fn invalid_registration_token_and_private_key_cannot_claim_a_route() {
        let (url, _stop) = relay(Config::new(TOKEN).unwrap()).await;
        let host = Identity::generate().unwrap();
        assert!(net::register_host(&url, &host, "incorrect-token")
            .await
            .is_err());
        let peer = host.peer(url.clone(), "Test".into()).unwrap();
        assert!(matches!(
            net::join(&peer, Mode::Session).await,
            Err(Error::Offline)
        ));
        let mut attacker = net::connect(&url).await.unwrap();
        net::send_json(
            &mut attacker,
            &Registration::Host {
                public_key: host.public_key(),
                access_token: zeroize::Zeroizing::new(TOKEN.into()),
            },
        )
        .await
        .unwrap();
        let challenge = net::receive_packet(&mut attacker).await.unwrap();
        let wrong = Identity::generate().unwrap();
        let mut proof = Handshake::registration_response(&wrong, None).unwrap();
        assert!(proof.read(&challenge).is_err());
        assert!(matches!(
            net::join(&peer, Mode::Session).await,
            Err(Error::Offline)
        ));
    }
    #[tokio::test]
    async fn blind_relay_carries_noise_and_large_bidirectional_streams_without_ssh() {
        let (url, _stop) = relay(Config::new(TOKEN).unwrap()).await;
        let host = Identity::generate().unwrap();
        let phone = Identity::generate().unwrap();
        let peer = host.peer(url.clone(), "Test".into()).unwrap();
        let mut control = net::register_host(&url, &host, TOKEN).await.unwrap();
        let (mut a, mut b) = pair_sockets(&url, &host, &mut control).await;
        let mut initiator = Handshake::session(&phone, &peer, true).unwrap();
        let mut responder = Handshake::session(&host, &peer, false).unwrap();
        net::send_packet(&mut a, initiator.write(&[]).unwrap())
            .await
            .unwrap();
        responder
            .read(&net::receive_packet(&mut b).await.unwrap())
            .unwrap();
        assert_eq!(responder.remote_key().unwrap(), *phone.public_bytes()); // explicit endpoint authorization seam
        net::send_packet(&mut b, responder.write(&[]).unwrap())
            .await
            .unwrap();
        initiator
            .read(&net::receive_packet(&mut a).await.unwrap())
            .unwrap();
        let mut a: EncryptedStream =
            SecureChannel::new(a, initiator.finish().unwrap()).into_stream();
        let mut b: EncryptedStream =
            SecureChannel::new(b, responder.finish().unwrap()).into_stream();
        let data = vec![0xA5; CHUNK * 5 + 17];
        let expected = data.clone();
        let echo = tokio::spawn(async move {
            let mut got = vec![0; expected.len()];
            b.read_exact(&mut got).await.unwrap();
            assert_eq!(got, expected);
            b.write_all(b"encrypted reply").await.unwrap();
            b.flush().await.unwrap();
        });
        a.write_all(&data).await.unwrap();
        let mut reply = [0; 15];
        a.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"encrypted reply");
        echo.await.unwrap();
    }
    #[tokio::test]
    async fn stalled_plaintext_consumer_closes_stream_instead_of_buffering_without_bound() {
        let (url, _stop) = relay(Config::new(TOKEN).unwrap()).await;
        let host = Identity::generate().unwrap();
        let phone = Identity::generate().unwrap();
        let peer = host.peer(url.clone(), "Test".into()).unwrap();
        let mut control = net::register_host(&url, &host, TOKEN).await.unwrap();
        let (mut a, mut b) = pair_sockets(&url, &host, &mut control).await;
        let mut initiator = Handshake::session(&phone, &peer, true).unwrap();
        let mut responder = Handshake::session(&host, &peer, false).unwrap();
        net::send_packet(&mut a, initiator.write(&[]).unwrap())
            .await
            .unwrap();
        responder
            .read(&net::receive_packet(&mut b).await.unwrap())
            .unwrap();
        net::send_packet(&mut b, responder.write(&[]).unwrap())
            .await
            .unwrap();
        initiator
            .read(&net::receive_packet(&mut a).await.unwrap())
            .unwrap();
        let mut a = SecureChannel::new(a, initiator.finish().unwrap()).into_stream();
        let mut b = SecureChannel::new(b, responder.finish().unwrap()).into_stream();
        // More than the receiver's bounded plaintext buffer, without reading it.
        a.write_all(&vec![7; CHUNK * 4]).await.unwrap();
        a.flush().await.unwrap();
        let mut closed = [0; 1];
        let eof = tokio::time::timeout(
            IO_TIMEOUT + std::time::Duration::from_secs(3),
            a.read(&mut closed),
        )
        .await
        .expect("stalled peer must close within the write deadline")
        .unwrap();
        assert_eq!(eof, 0);
        let mut received = Vec::new();
        b.read_to_end(&mut received).await.unwrap();
        assert!(
            received.len() <= CHUNK * 2,
            "only the bounded duplex buffer remains"
        );
    }
    #[tokio::test]
    async fn wrong_computer_cannot_accept_another_hosts_pending_phone() {
        let (url, _stop) = relay(Config::new(TOKEN).unwrap()).await;
        let host = Identity::generate().unwrap();
        let attacker = Identity::generate().unwrap();
        let mut control = net::register_host(&url, &host, TOKEN).await.unwrap();
        let peer = host.peer(url.clone(), "Test".into()).unwrap();
        let phone = tokio::spawn(async move { net::join(&peer, Mode::Session).await.unwrap() });
        let Control::Incoming { connection_id, .. } =
            net::receive_json(&mut control).await.unwrap()
        else {
            panic!()
        };
        assert!(net::accept_connection(&url, &attacker, &connection_id)
            .await
            .is_err());
        let _socket = net::accept_connection(&url, &host, &connection_id)
            .await
            .unwrap();
        let _phone = phone.await.unwrap();
    }
    #[tokio::test]
    async fn replacing_registration_fences_old_cleanup_and_pending_joins_are_bounded() {
        let mut config = Config::new(TOKEN).unwrap();
        config.max_pending_per_host = 1;
        let (url, _stop) = relay(config).await;
        let host = Identity::generate().unwrap();
        let old = net::register_host(&url, &host, TOKEN).await.unwrap();
        let mut current = net::register_host(&url, &host, TOKEN).await.unwrap();
        drop(old);
        let peer = host.peer(url.clone(), "Test".into()).unwrap();
        let first_peer = peer.clone();
        let first = tokio::spawn(async move { net::join(&first_peer, Mode::Session).await });
        let _: Control = net::receive_json(&mut current).await.unwrap();
        assert!(matches!(
            net::join(&peer, Mode::Session).await,
            Err(Error::Busy)
        ));
        first.abort();
    }
    #[tokio::test]
    async fn accepted_socket_keeps_its_capacity_lease_and_oversized_frames_close_the_tunnel() {
        let mut config = Config::new(TOKEN).unwrap();
        config.max_connections = 3;
        config.max_hosts = 1;
        let (url, _stop) = relay(config).await;
        let host = Identity::generate().unwrap();
        let mut control = net::register_host(&url, &host, TOKEN).await.unwrap();
        let (mut phone, mut desktop) = pair_sockets(&url, &host, &mut control).await;
        assert!(
            net::connect(&url).await.is_err(),
            "all three live sockets retain their capacity leases"
        );
        phone
            .send(Message::Binary(vec![7; MAX_CIPHER + 1].into()))
            .await
            .unwrap();
        assert!(net::receive_packet(&mut desktop).await.is_err());
    }
}
