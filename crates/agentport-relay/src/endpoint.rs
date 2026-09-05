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

pub async fn connect_session(identity: &Identity, peer: &Peer) -> Result<EncryptedStream> {
    let mut socket = net::join(peer, Mode::Session).await?;
    let mut noise = Handshake::session(identity, peer, true)?;
    net::send_packet(&mut socket, noise.write(&[])?).await?;
    let response = noise.read(&net::receive_packet(&mut socket).await?)?;
    if response.as_slice() != b"accepted" {
        return Err(Error::Unauthorized);
    }
    Ok(SecureChannel::new(socket, noise.finish()?).into_stream())
}
