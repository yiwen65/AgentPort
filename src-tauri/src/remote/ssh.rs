//! SSH transport: russh client exec'ing the remote bridge over a session
//! channel, adapted to the blocking `FrameReader`/`FrameWriter` traits via a
//! dedicated thread running a small tokio runtime.

use std::borrow::Cow;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use russh::keys::{decode_secret_key, ssh_key::PublicKey, HashAlg, PrivateKeyWithHashAlg};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::Zeroizing;

use crate::remote::tofu::{TofuDecision, TofuStore};
use crate::remote::transport::{encode_frame, FrameReader, FrameWriter, TransportError};
use crate::remote::RemoteCommandError;

const BRIDGE_COMMAND: &str = "agentport-remote-bridge serve --stdio";
const WRITE_ACK_TIMEOUT: Duration = Duration::from_secs(60);

/// One outbound write job: serialized JSON payload + completion ack.
pub(crate) type OutboundJob = (Vec<u8>, mpsc::Sender<Result<(), String>>);
type OutboundTx = tokio::sync::mpsc::UnboundedSender<OutboundJob>;
type OutboundRx = tokio::sync::mpsc::UnboundedReceiver<OutboundJob>;
pub(crate) type FramedHalves = (Box<dyn FrameReader>, Box<dyn FrameWriter>);

#[derive(Debug, Clone)]
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Debug)]
#[allow(dead_code)] // constructed by the T-003 credential store resolver
pub enum SshSecret {
    Password(Zeroizing<String>),
    PrivateKey {
        pem: Zeroizing<String>,
        passphrase: Option<Zeroizing<String>>,
    },
}

/// Shared with the russh handler so a rejected key keeps its precise reason.
#[derive(Default)]
struct TofuVerdict {
    rejection: Mutex<Option<RemoteCommandError>>,
    pending_new_host: Mutex<Option<crate::remote::tofu::TofuEntry>>,
}

struct TofuHandler {
    target: SshTarget,
    tofu: Arc<Mutex<TofuStore>>,
    verdict: Arc<TofuVerdict>,
}

impl russh::client::Handler for TofuHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let decision = self
            .tofu
            .lock()
            .unwrap()
            .check(&self.target.host, self.target.port, key);
        match decision {
            Ok(TofuDecision::Match) => Ok(true),
            Ok(TofuDecision::NewHost(entry)) => {
                *self.verdict.pending_new_host.lock().unwrap() = Some(entry);
                Ok(true)
            }
            Err(error) => {
                *self.verdict.rejection.lock().unwrap() = Some(error);
                Ok(false)
            }
        }
    }
}

/// Blocking frame reader fed by an async transport thread (SSH exec channel,
/// relay encrypted stream). A received `Err` reason surfaces once as an Io
/// transport error; a dropped sender reads as a clean peer EOF.
pub(crate) struct ChannelFrameReader {
    pub(crate) inbound: mpsc::Receiver<Result<Vec<u8>, String>>,
}

impl FrameReader for ChannelFrameReader {
    fn read_frame(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        match self.inbound.recv() {
            Ok(Ok(frame)) => Ok(Some(frame)),
            Ok(Err(reason)) => Err(TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::ConnectionAborted,
                reason,
            ))),
            Err(_) => Ok(None), // SSH thread gone: treat as clean EOF
        }
    }
}

/// Blocking frame writer relayed to an async transport thread with per-write
/// acknowledgements. `shutdown` drops the sender so the async writer task
/// half-closes the peer stream instead of deadlocking the reader thread.
pub(crate) struct ChannelFrameWriter {
    pub(crate) outbound: OutboundTx,
}

impl FrameWriter for ChannelFrameWriter {
    fn write_frame(&mut self, payload: &[u8]) -> Result<(), TransportError> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.outbound
            .send((payload.to_vec(), ack_tx))
            .map_err(|_| TransportError::Closed)?;
        match ack_rx.recv_timeout(WRITE_ACK_TIMEOUT) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(reason)) => Err(TransportError::Io(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                reason,
            ))),
            Err(mpsc::RecvTimeoutError::Timeout) => Err(TransportError::Timeout),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(TransportError::Closed),
        }
    }

    fn shutdown(&mut self) {
        // Dropping the last sender ends the writer task, which EOFs the
        // exec channel so the remote bridge exits on its own.
        let (replacement, _) = tokio::sync::mpsc::unbounded_channel();
        self.outbound = replacement;
    }
}

/// Connects, authenticates, starts the bridge and returns the framed halves.
/// Blocks the calling thread; run inside `spawn_blocking`.
pub fn connect(
    target: &SshTarget,
    secret: &SshSecret,
    tofu: Arc<Mutex<TofuStore>>,
    timeout: Duration,
) -> Result<FramedHalves, RemoteCommandError> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), RemoteCommandError>>();
    let (inbound_tx, inbound_rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    let (outbound_tx, outbound_rx) = tokio::sync::mpsc::unbounded_channel::<OutboundJob>();
    let target_owned = target.clone();
    // Secret material moves into the SSH thread and never leaves it.
    let secret = match secret {
        SshSecret::Password(value) => {
            SshSecret::Password(Zeroizing::new(value.as_str().to_string()))
        }
        SshSecret::PrivateKey { pem, passphrase } => SshSecret::PrivateKey {
            pem: Zeroizing::new(pem.as_str().to_string()),
            passphrase: passphrase
                .as_ref()
                .map(|value| Zeroizing::new(value.as_str().to_string())),
        },
    };

    std::thread::Builder::new()
        .name("agentport-remote-ssh".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_tx.send(Err(RemoteCommandError::new(
                        "ssh_runtime_failed",
                        error.to_string(),
                    )));
                    return;
                }
            };
            runtime.block_on(drive(
                target_owned,
                secret,
                tofu,
                timeout,
                ready_tx,
                inbound_tx,
                outbound_rx,
            ));
        })
        .map_err(|error| RemoteCommandError::new("ssh_thread_failed", error.to_string()))?;

    match ready_rx.recv_timeout(timeout + Duration::from_secs(10)) {
        Ok(result) => result?,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(RemoteCommandError::new(
                "ssh_connect_timeout",
                format!("no SSH handshake progress within {}s", timeout.as_secs()),
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(RemoteCommandError::new(
                "ssh_connect_failed",
                "SSH thread exited before reporting readiness",
            ))
        }
    }
    Ok((
        Box::new(ChannelFrameReader {
            inbound: inbound_rx,
        }),
        Box::new(ChannelFrameWriter {
            outbound: outbound_tx,
        }),
    ))
}

/// Reads length-prefixed frames from an async reader and forwards payloads to
/// the blocking `ChannelFrameReader`. Shared by the SSH and relay transports.
pub(crate) async fn forward_frames<R>(mut reader: R, inbound: mpsc::Sender<Result<Vec<u8>, String>>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    loop {
        let mut header = [0_u8; 4];
        if let Err(error) = reader.read_exact(&mut header).await {
            let reason = if error.kind() == std::io::ErrorKind::UnexpectedEof {
                "bridge closed the stream".to_string()
            } else {
                format!("bridge read failed: {error}")
            };
            let _ = inbound.send(Err(reason));
            return;
        }
        let length = u32::from_be_bytes(header);
        if length > agentport_remote_protocol::MAX_FRAME_BYTES {
            let _ = inbound.send(Err(format!(
                "bridge frame exceeds {} bytes",
                agentport_remote_protocol::MAX_FRAME_BYTES
            )));
            return;
        }
        let mut payload = vec![0_u8; length as usize];
        if let Err(error) = reader.read_exact(&mut payload).await {
            let _ = inbound.send(Err(format!("bridge frame truncated: {error}")));
            return;
        }
        if inbound.send(Ok(payload)).is_err() {
            return; // client side is gone
        }
    }
}

/// Writes outbound jobs as length-prefixed frames with per-write acks, then
/// half-closes once every sender is gone. Shared by SSH and relay transports.
pub(crate) async fn write_frames<W>(mut writer: W, mut outbound: OutboundRx)
where
    W: tokio::io::AsyncWrite + Unpin,
{
    while let Some((payload, ack)) = outbound.recv().await {
        let result = match encode_frame(&payload) {
            Ok(frame) => writer
                .write_all(&frame)
                .await
                .map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        let failed = result.is_err();
        let _ = ack.send(result);
        if failed {
            return;
        }
    }
    // All senders dropped: graceful half-close so the bridge sees EOF.
    let _ = writer.shutdown().await;
}

/// SSH transport options shared by every remote device dial.
///
/// Terminal traffic is highly compressible text and remote devices are
/// usually reached over a high-latency WAN. OpenSSH's delayed zlib is offered
/// first but `none` stays last, so hosts that disable compression still
/// negotiate. `nodelay` matches OpenSSH's interactive-shell default: without
/// it Nagle delays small window-adjust/input packets by up to one RTT
/// (measured on a ~170 ms link: 0.28 MB/s -> 0.52 MB/s without compression,
/// 0.95-1.47 MB/s with it).
fn transport_config() -> russh::client::Config {
    let mut config = russh::client::Config::default();
    config.preferred.compression = Cow::Borrowed(&[
        russh::compression::ZLIB_LEGACY,
        russh::compression::ZLIB,
        russh::compression::NONE,
    ]);
    config.nodelay = true;
    config
}

async fn drive(
    target: SshTarget,
    secret: SshSecret,
    tofu: Arc<Mutex<TofuStore>>,
    timeout: Duration,
    ready_tx: mpsc::Sender<Result<(), RemoteCommandError>>,
    inbound_tx: mpsc::Sender<Result<Vec<u8>, String>>,
    outbound_rx: OutboundRx,
) {
    let verdict = Arc::new(TofuVerdict::default());
    let handler = TofuHandler {
        target: target.clone(),
        tofu: Arc::clone(&tofu),
        verdict: Arc::clone(&verdict),
    };
    let config = Arc::new(transport_config());
    let mut handle = match tokio::time::timeout(
        timeout,
        russh::client::connect(config, (target.host.as_str(), target.port), handler),
    )
    .await
    {
        Ok(Ok(handle)) => handle,
        Ok(Err(error)) => {
            let rejection = verdict.rejection.lock().unwrap().take();
            let error = rejection.unwrap_or_else(|| {
                RemoteCommandError::new("ssh_connect_failed", error.to_string())
            });
            let _ = ready_tx.send(Err(error));
            return;
        }
        Err(_) => {
            let _ = ready_tx.send(Err(RemoteCommandError::new(
                "ssh_connect_timeout",
                format!("SSH handshake exceeded {}s", timeout.as_secs()),
            )));
            return;
        }
    };

    let authenticated = match &secret {
        SshSecret::Password(password) => handle
            .authenticate_password(target.username.clone(), password.as_str().to_string())
            .await
            .map(|result| result.success()),
        SshSecret::PrivateKey { pem, passphrase } => {
            match decode_secret_key(pem.as_str(), passphrase.as_ref().map(|p| p.as_str())) {
                Ok(key) => handle
                    .authenticate_publickey(
                        target.username.clone(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), None::<HashAlg>),
                    )
                    .await
                    .map(|result| result.success()),
                Err(error) => {
                    let _ = ready_tx.send(Err(RemoteCommandError::new(
                        "ssh_key_invalid",
                        format!("cannot decode private key: {error}"),
                    )));
                    return;
                }
            }
        }
    };
    match authenticated {
        Ok(true) => {}
        Ok(false) => {
            let _ = ready_tx.send(Err(RemoteCommandError::new(
                "ssh_auth_failed",
                format!("authentication failed for {}", target.username),
            )));
            return;
        }
        Err(error) => {
            let _ = ready_tx.send(Err(RemoteCommandError::new(
                "ssh_connect_failed",
                error.to_string(),
            )));
            return;
        }
    }

    // Record first-use trust only after the peer proved it holds the key.
    if let Some(entry) = verdict.pending_new_host.lock().unwrap().take() {
        if let Err(error) = tofu
            .lock()
            .unwrap()
            .commit(&target.host, target.port, entry)
        {
            let _ = ready_tx.send(Err(error));
            return;
        }
    }

    let channel = match handle.channel_open_session().await {
        Ok(channel) => channel,
        Err(error) => {
            let _ = ready_tx.send(Err(RemoteCommandError::new(
                "ssh_channel_failed",
                error.to_string(),
            )));
            return;
        }
    };
    if let Err(error) = channel.exec(false, BRIDGE_COMMAND).await {
        let _ = ready_tx.send(Err(RemoteCommandError::new(
            "bridge_start_failed",
            format!("cannot start `{BRIDGE_COMMAND}`: {error}"),
        )));
        return;
    }
    let (mut reader_half, writer_half) = channel.split();
    if ready_tx.send(Ok(())).is_err() {
        return; // caller gave up while we connected
    }

    let read_loop = {
        let inbound = inbound_tx.clone();
        async move { forward_frames(reader_half.make_reader(), inbound).await }
    };
    let write_loop = write_frames(writer_half.make_writer(), outbound_rx);

    tokio::select! {
        _ = read_loop => {}
        _ = write_loop => {}
    }
    // Dropping `handle` disconnects the SSH session.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_config_prefers_compression_with_none_fallback() {
        let config = super::transport_config();
        let names: Vec<&str> = config
            .preferred
            .compression
            .iter()
            .map(|name| name.as_ref())
            .collect();
        // Client order wins in SSH negotiation: zlib first, `none` last so a
        // host with `Compression no` still connects.
        assert_eq!(names, vec!["zlib@openssh.com", "zlib", "none"]);
        assert!(config.nodelay, "interactive SSH must not leave Nagle on");
    }

    #[test]
    fn ssh_secret_roundtrip_clone_is_zeroizing() {
        let secret = SshSecret::Password(Zeroizing::new("s3cret".to_string()));
        match secret {
            SshSecret::Password(value) => assert_eq!(value.as_str(), "s3cret"),
            _ => panic!("wrong variant"),
        }
    }
}
