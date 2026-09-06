use crate::{
    crypto::{Established, Handshake, Identity},
    protocol::*,
    Error, Result,
};
use futures_util::{task::AtomicWaker, SinkExt, StreamExt};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream, ReadBuf},
    net::TcpStream,
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    Connector, MaybeTlsStream, WebSocketStream,
};
use zeroize::Zeroizing;

#[cfg(test)]
mod tls_tests {
    #[tokio::test]
    #[ignore = "requires explicit AGENTPORT_RELAY_TLS_PROBE_URL; WebSocket upgrade only"]
    async fn trusted_public_wss_upgrade() {
        let url = std::env::var("AGENTPORT_RELAY_TLS_PROBE_URL").unwrap();
        assert!(url.starts_with("wss://"));
        let mut socket = super::connect(&url).await.unwrap();
        socket.close(None).await.unwrap();
    }

    #[tokio::test]
    async fn wss_failure_returns_error_without_panicking() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            drop(socket);
        });
        let result =
            tokio::spawn(async move { super::connect(&format!("wss://{address}/v1/relay")).await })
                .await;
        peer.await.unwrap();
        assert!(
            result.is_ok(),
            "TLS initialization must not panic and strand a native invoke"
        );
        assert!(
            result.unwrap().is_err(),
            "A non-TLS peer must not be trusted"
        );
    }
}

pub type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;
pub const IO_TIMEOUT: Duration = Duration::from_secs(10);
pub const HEARTBEAT: Duration = Duration::from_secs(15);
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(50);
pub fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_CIPHER * 2)
        .max_message_size(Some(MAX_CIPHER))
        .max_frame_size(Some(MAX_CIPHER))
}
pub async fn timed<T>(future: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(IO_TIMEOUT, future)
        .await
        .map_err(|_| Error::Timeout)?
}
pub async fn connect(url: &str) -> Result<Socket> {
    validate_url(url)?;
    timed(async {
        // Select a provider per connection, independent of feature unification
        // in the embedding app. Implicit rustls initialization can panic when
        // zero or multiple providers are enabled, stranding native RPC callers.
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|_| Error::Protocol)?
        .with_root_certificates(rustls::RootCertStore::from_iter(
            webpki_roots::TLS_SERVER_ROOTS.iter().cloned(),
        ))
        .with_no_client_auth();
        Ok(connect_async_tls_with_config(
            url,
            Some(socket_config()),
            true,
            Some(Connector::Rustls(Arc::new(config))),
        )
        .await?
        .0)
    })
    .await
}
pub async fn send_packet(socket: &mut Socket, bytes: Vec<u8>) -> Result<()> {
    if bytes.len() > MAX_CIPHER {
        return Err(Error::Invalid("frame length"));
    }
    timed(async {
        socket.send(Message::Binary(bytes.into())).await?;
        Ok(())
    })
    .await
}
pub async fn receive_packet(socket: &mut Socket) -> Result<Zeroizing<Vec<u8>>> {
    timed(async {
        loop {
            match socket.next().await.ok_or(Error::Transport)?? {
                Message::Binary(bytes) if bytes.len() <= MAX_CIPHER => {
                    return Ok(Zeroizing::new(bytes.to_vec()))
                }
                Message::Ping(_) => socket.flush().await?,
                Message::Pong(_) => {}
                Message::Close(_) => return Err(Error::Transport),
                _ => return Err(Error::Protocol),
            }
        }
    })
    .await
}
pub async fn send_json<T: Serialize>(socket: &mut Socket, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_CONTROL {
        return Err(Error::Invalid("control length"));
    }
    send_packet(socket, bytes).await
}
pub async fn receive_json<T: DeserializeOwned>(socket: &mut Socket) -> Result<T> {
    let bytes = receive_packet(socket).await?;
    if bytes.len() > MAX_CONTROL {
        return Err(Error::Protocol);
    }
    Ok(serde_json::from_slice(&bytes)?)
}
async fn ready(socket: &mut Socket) -> Result<()> {
    match receive_json::<Control>(socket).await? {
        Control::Ready => Ok(()),
        Control::Rejected { reason } => Err(reason.into()),
        _ => Err(Error::Protocol),
    }
}
async fn prove(
    socket: &mut Socket,
    identity: &Identity,
    connection_id: Option<&str>,
) -> Result<()> {
    let mut noise = Handshake::registration_response(identity, connection_id)?;
    noise.read(&receive_packet(socket).await?)?;
    send_packet(socket, noise.write(&[])?).await?;
    noise.finish()?;
    ready(socket).await
}
pub async fn register_host(url: &str, identity: &Identity, access_token: &str) -> Result<Socket> {
    let mut socket = connect(url).await?;
    send_json(
        &mut socket,
        &Registration::Host {
            public_key: identity.public_key(),
            access_token: Zeroizing::new(access_token.to_string()),
        },
    )
    .await?;
    prove(&mut socket, identity, None).await?;
    Ok(socket)
}
pub async fn accept_connection(
    url: &str,
    identity: &Identity,
    connection_id: &str,
) -> Result<Socket> {
    decode::<16>(connection_id)?;
    let mut socket = connect(url).await?;
    send_json(
        &mut socket,
        &Registration::Accept {
            public_key: identity.public_key(),
            connection_id: connection_id.to_string(),
        },
    )
    .await?;
    prove(&mut socket, identity, Some(connection_id)).await?;
    Ok(socket)
}
pub async fn join(peer: &Peer, mode: Mode) -> Result<Socket> {
    peer.validate()?;
    mode.context(&peer.host_id)?;
    let mut socket = connect(&peer.relay_url).await?;
    send_json(
        &mut socket,
        &Registration::Join {
            host_id: peer.host_id.clone(),
            mode,
        },
    )
    .await?;
    ready(&mut socket).await?;
    Ok(socket)
}

/// Secure application messages used during pairing, before accepting the normal
/// Bridge byte stream. The Relay sees only bounded ciphertext frames.
pub struct SecureChannel {
    socket: Socket,
    cipher: snow::TransportState,
}
impl SecureChannel {
    pub fn new(socket: Socket, established: Established) -> Self {
        Self {
            socket,
            cipher: established.cipher,
        }
    }
    pub async fn send<T: Serialize>(&mut self, value: &T) -> Result<()> {
        let plaintext = Zeroizing::new(serde_json::to_vec(value)?);
        if plaintext.len() > MAX_CONTROL {
            return Err(Error::Invalid("secure control length"));
        }
        let mut ciphertext = vec![0; plaintext.len() + 16];
        let n = self.cipher.write_message(&plaintext, &mut ciphertext)?;
        ciphertext.truncate(n);
        send_packet(&mut self.socket, ciphertext).await
    }
    pub async fn receive<T: DeserializeOwned>(&mut self) -> Result<T> {
        let ciphertext = receive_packet(&mut self.socket).await?;
        if ciphertext.len() > MAX_CONTROL + 16 {
            return Err(Error::Protocol);
        }
        let mut plaintext = Zeroizing::new(vec![0; MAX_CONTROL]);
        let n = self.cipher.read_message(&ciphertext, &mut plaintext)?;
        Ok(serde_json::from_slice(&plaintext[..n])?)
    }
    pub fn into_stream(self) -> EncryptedStream {
        let (stream, local) = tokio::io::duplex(CHUNK * 2);
        let progress = Arc::new(WriteProgress::default());
        let worker_progress = progress.clone();
        let task = tokio::spawn(async move {
            let _closed = PumpClosed(worker_progress.clone());
            let _ = pump(self.socket, self.cipher, local, worker_progress).await;
        });
        EncryptedStream {
            stream,
            task,
            written: 0,
            progress,
        }
    }
}
/// Owns its pump: dropping a cancelled/obsolete connection closes the WebSocket.
/// No auto-replay; a fresh Noise handshake is mandatory on every reconnect.
#[derive(Default)]
struct WriteProgress {
    sent: AtomicU64,
    closed: AtomicBool,
    waker: AtomicWaker,
}
struct PumpClosed(Arc<WriteProgress>);
impl Drop for PumpClosed {
    fn drop(&mut self) {
        self.0.closed.store(true, Ordering::Release);
        self.0.waker.wake();
    }
}
pub struct EncryptedStream {
    stream: DuplexStream,
    task: JoinHandle<()>,
    written: u64,
    progress: Arc<WriteProgress>,
}
impl EncryptedStream {
    /// Native connection owners can cancel the pump even while split reader and
    /// writer halves are retained by pending requests or a blocked reader loop.
    pub fn abort_handle(&self) -> tokio::task::AbortHandle {
        self.task.abort_handle()
    }
}
impl Drop for EncryptedStream {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl AsyncRead for EncryptedStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}
impl AsyncWrite for EncryptedStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match Pin::new(&mut self.stream).poll_write(cx, buf) {
            Poll::Ready(Ok(count)) => {
                self.written += count as u64;
                Poll::Ready(Ok(count))
            }
            value => value,
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        // A DuplexStream flush alone does not flush its downstream WebSocket.
        // Publish completion only after the pump has sent all preceding bytes.
        self.progress.waker.register(cx.waker());
        if self.progress.sent.load(Ordering::Acquire) >= self.written {
            return Poll::Ready(Ok(()));
        }
        if self.progress.closed.load(Ordering::Acquire) {
            return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
        }
        Poll::Pending
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.as_mut().poll_flush(cx) {
            Poll::Ready(Ok(())) => Pin::new(&mut self.stream).poll_shutdown(cx),
            value => value,
        }
    }
}
async fn pump(
    mut socket: Socket,
    mut cipher: snow::TransportState,
    mut local: DuplexStream,
    progress: Arc<WriteProgress>,
) -> Result<()> {
    let mut input = Zeroizing::new(vec![0; CHUNK]);
    let mut plaintext = Zeroizing::new(vec![0; MAX_CIPHER]);
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    let mut received = tokio::time::Instant::now();
    loop {
        tokio::select! {
            count = local.read(&mut input) => {
                let count = count?; if count == 0 { return Ok(()); }
                let mut encrypted = vec![0; count + 16]; let n = cipher.write_message(&input[..count], &mut encrypted)?; encrypted.truncate(n);
                send_packet(&mut socket, encrypted).await?;
                progress.sent.fetch_add(count as u64, Ordering::Release); progress.waker.wake();
            }
            message = socket.next() => {
                received = tokio::time::Instant::now();
                match message.ok_or(Error::Transport)?? {
                    Message::Binary(bytes) => {
                        if bytes.len() > MAX_CIPHER { return Err(Error::Protocol); }
                        let count = cipher.read_message(&bytes, &mut plaintext)?;
                        timed(async { local.write_all(&plaintext[..count]).await?; Ok(()) }).await?;
                    }
                    Message::Ping(_) => { timed(async { socket.flush().await?; Ok(()) }).await?; }
                    Message::Pong(_) => {},
                    Message::Close(_) => return Ok(()),
                    _ => return Err(Error::Protocol),
                }
            }
            _ = heartbeat.tick() => {
                if received.elapsed() > IDLE_TIMEOUT { return Err(Error::Timeout); }
                timed(async { socket.send(Message::Ping(Vec::new().into())).await?; Ok(()) }).await?;
            }
        }
    }
}
