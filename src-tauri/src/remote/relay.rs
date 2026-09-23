//! Relay transport: an end-to-end Noise (or negotiated WSS) stream to a
//! paired AgentPort connector, adapted to the blocking frame halves via a
//! dedicated thread running a small tokio runtime — the same shape as the
//! SSH transport, so connections behave identically downstream.

use std::sync::{mpsc, Arc};
use std::time::Duration;

use agentport_relay::crypto::Identity;
use agentport_relay::endpoint::connect_session_realtime;
use agentport_relay::protocol::Peer;

use crate::remote::ssh::{
    forward_frames, write_frames, ChannelFrameReader, ChannelFrameWriter, FramedHalves,
};
use crate::remote::RemoteCommandError;

/// Maps relay endpoint errors to stable frontend codes.
pub fn map_relay_error(error: agentport_relay::Error) -> RemoteCommandError {
    let code = match error {
        agentport_relay::Error::Unauthorized => "pairing_unauthorized",
        agentport_relay::Error::Offline => "device_offline",
        agentport_relay::Error::Timeout => "relay_timeout",
        agentport_relay::Error::Busy => "relay_busy",
        agentport_relay::Error::Transport => "relay_unreachable",
        agentport_relay::Error::Protocol => "relay_protocol",
        agentport_relay::Error::Invalid(_) => "relay_invalid",
        agentport_relay::Error::Credential => "relay_credential",
        agentport_relay::Error::Storage => "relay_storage",
    };
    RemoteCommandError::new(code, error.to_string())
}

/// Opens the relay session and returns the framed halves. Blocks the calling
/// thread; run inside `spawn_blocking`.
pub fn connect(
    peer: &Peer,
    identity: Arc<Identity>,
    timeout: Duration,
) -> Result<FramedHalves, RemoteCommandError> {
    peer.validate()
        .map_err(|error| RemoteCommandError::new("relay_invalid", error.to_string()))?;
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), RemoteCommandError>>();
    let (inbound_tx, inbound_rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    let (outbound_tx, outbound_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::remote::ssh::OutboundJob>();
    let peer = peer.clone();

    std::thread::Builder::new()
        .name("agentport-remote-relay".into())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_tx.send(Err(RemoteCommandError::new(
                        "relay_runtime_failed",
                        error.to_string(),
                    )));
                    return;
                }
            };
            runtime.block_on(drive(
                peer,
                identity,
                timeout,
                ready_tx,
                inbound_tx,
                outbound_rx,
            ));
        })
        .map_err(|error| RemoteCommandError::new("relay_thread_failed", error.to_string()))?;

    match ready_rx.recv_timeout(timeout + Duration::from_secs(10)) {
        Ok(result) => result?,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            return Err(RemoteCommandError::new(
                "relay_timeout",
                format!("no relay session progress within {}s", timeout.as_secs()),
            ))
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            return Err(RemoteCommandError::new(
                "relay_connect_failed",
                "relay thread exited before reporting readiness",
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

async fn drive(
    peer: Peer,
    identity: Arc<Identity>,
    timeout: Duration,
    ready_tx: mpsc::Sender<Result<(), RemoteCommandError>>,
    inbound_tx: mpsc::Sender<Result<Vec<u8>, String>>,
    outbound_rx: tokio::sync::mpsc::UnboundedReceiver<crate::remote::ssh::OutboundJob>,
) {
    let stream =
        match tokio::time::timeout(timeout, connect_session_realtime(identity.as_ref(), &peer))
            .await
        {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => {
                let _ = ready_tx.send(Err(map_relay_error(error)));
                return;
            }
            Err(_) => {
                let _ = ready_tx.send(Err(RemoteCommandError::new(
                    "relay_timeout",
                    format!("relay session handshake exceeded {}s", timeout.as_secs()),
                )));
                return;
            }
        };
    let (reader_half, writer_half) = tokio::io::split(stream);
    if ready_tx.send(Ok(())).is_err() {
        return; // caller gave up while we connected
    }
    let read_loop = forward_frames(reader_half, inbound_tx);
    let write_loop = write_frames(writer_half, outbound_rx);
    tokio::select! {
        _ = read_loop => {}
        _ = write_loop => {}
    }
    // Dropping the stream aborts its pump task and closes the WebSocket.
}
