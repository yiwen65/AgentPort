//! Endpoint wire messages. Approval is performed by the connector, never Relay.
use crate::{
    crypto::{Handshake, Identity},
    net::{self, EncryptedStream, SecureChannel},
    protocol::*,
    Error, Result,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairHello {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PairReply {
    Pending {
        request_id: String,
    },
    Approved {
        request_id: String,
        public_key: String,
        host_id: String,
    },
    Denied,
}

pub struct PairingConnection {
    channel: SecureChannel,
    pub verification_code: String,
    pub request_id: String,
    public_key: String,
    host_id: String,
    expires_at: u64,
}
impl PairingConnection {
    /// The native caller must persist custody of this identity before calling:
    /// a cancelled/unknown approval cannot safely discard the possibly allowed key.
    pub async fn begin(identity: &Identity, invitation: &Invitation, name: String) -> Result<Self> {
        validate_name(&name)?;
        invitation.validate()?;
        let mut socket = net::join(
            &invitation.peer,
            Mode::Pair {
                invitation_id: invitation.id.clone(),
            },
        )
        .await?;
        let mut noise = Handshake::pair(identity, invitation, true)?;
        net::send_packet(&mut socket, noise.write(&[])?).await?;
        noise.read(&net::receive_packet(&mut socket).await?)?;
        net::send_packet(
            &mut socket,
            noise.write(&serde_json::to_vec(&PairHello { name })?)?,
        )
        .await?;
        let established = noise.finish()?;
        let verification_code = established.verification_code.clone();
        let mut channel = SecureChannel::new(socket, established);
        let request_id = match channel.receive().await? {
            PairReply::Pending { request_id } => {
                decode::<16>(&request_id)?;
                request_id
            }
            _ => return Err(Error::Unauthorized),
        };
        Ok(Self {
            channel,
            verification_code,
            request_id,
            public_key: identity.public_key(),
            host_id: invitation.peer.host_id.clone(),
            expires_at: invitation.expires_at,
        })
    }
    pub async fn wait(mut self) -> Result<()> {
        let duration = std::time::Duration::from_secs(self.expires_at.saturating_sub(now()) + 1);
        tokio::time::timeout(duration, async {
            loop {
                match self.channel.receive().await? {
                    PairReply::Pending { request_id } if request_id == self.request_id => {}
                    PairReply::Approved {
                        request_id,
                        public_key,
                        host_id,
                    } if request_id == self.request_id
                        && public_key == self.public_key
                        && host_id == self.host_id =>
                    {
                        return Ok(())
                    }
                    _ => return Err(Error::Unauthorized),
                }
            }
        })
        .await
        .map_err(|_| Error::Timeout)?
    }
}

pub(crate) const WSS_STREAM_OFFER: &[u8] = b"wss-stream-v1";
pub(crate) const WSS_STREAM_ACCEPTED: &[u8] = b"accepted:wss-stream-v1";

pub async fn connect_session(identity: &Identity, peer: &Peer) -> Result<EncryptedStream> {
    connect_session_mode(identity, peer, false).await
}

/// Authenticate the device as before, then avoid a second encryption layer on
/// terminal data when the Connector accepts. WSS terminates at the Relay, so
/// this mode intentionally permits the Relay to read session data.
pub async fn connect_session_realtime(identity: &Identity, peer: &Peer) -> Result<EncryptedStream> {
    connect_session_mode(identity, peer, true).await
}

async fn connect_session_mode(
    identity: &Identity,
    peer: &Peer,
    realtime: bool,
) -> Result<EncryptedStream> {
    let mut socket = net::join(peer, Mode::Session).await?;
    let mut noise = Handshake::session(identity, peer, true)?;
    net::send_packet(
        &mut socket,
        noise.write(if realtime { WSS_STREAM_OFFER } else { &[] })?,
    )
    .await?;
    let response = noise.read(&net::receive_packet(&mut socket).await?)?;
    let established = noise.finish()?;
    if realtime && response.as_slice() == WSS_STREAM_ACCEPTED {
        Ok(EncryptedStream::authenticated_wss(socket))
    } else if response.as_slice() == b"accepted" {
        // Existing Connectors ignore the offer and retain Noise. Never guess
        // a transport mode or retry an uncertain session input.
        Ok(SecureChannel::new(socket, established).into_stream())
    } else {
        Err(Error::Unauthorized)
    }
}
