use crate::{Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    net::IpAddr,
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::{Zeroize, Zeroizing};

pub const VERSION: u8 = 1;
pub const PAIR_TTL: u64 = 120;
pub const MAX_CONTROL: usize = 4096;
pub const MAX_CIPHER: usize = 65535;
pub const CHUNK: usize = 32768;
pub const ENDPOINT: &str = "/v1/relay";
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0; N];
    getrandom::getrandom(&mut bytes).map_err(|_| Error::Invalid("random generator unavailable"))?;
    Ok(bytes)
}
pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
pub fn decode<const N: usize>(text: &str) -> Result<[u8; N]> {
    let bytes = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(text)
            .map_err(|_| Error::Invalid("key encoding"))?,
    );
    if encode(&bytes) != text {
        return Err(Error::Invalid("noncanonical key encoding"));
    }
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| Error::Invalid("key length"))
}
pub fn identifier() -> Result<String> {
    Ok(encode(&random::<16>()?))
}
pub fn host_id(public_key: &[u8]) -> String {
    encode(&Sha256::digest(public_key))
}
pub fn validate_url(value: &str) -> Result<()> {
    let url = url::Url::parse(value).map_err(|_| Error::Invalid("relay URL"))?;
    let loopback = url
        .host_str()
        .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback());
    if value.len() > 512
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url.path() != ENDPOINT
        || url.port() == Some(0)
        || !(url.scheme() == "wss" || (url.scheme() == "ws" && loopback))
    {
        return Err(Error::Invalid(
            "use wss://host/v1/relay; ws is restricted to literal loopback addresses",
        ));
    }
    Ok(())
}
pub fn validate_name(name: &str) -> Result<()> {
    if name.trim().is_empty() || name.len() > 80 || name.chars().any(char::is_control) {
        return Err(Error::Invalid("device name"));
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Peer {
    pub relay_url: String,
    pub public_key: String,
    pub host_id: String,
    pub name: String,
}
impl Peer {
    pub fn validate(&self) -> Result<()> {
        validate_url(&self.relay_url)?;
        validate_name(&self.name)?;
        let public = decode::<32>(&self.public_key)?;
        if public == [0; 32] || host_id(&public) != self.host_id {
            return Err(Error::Invalid("computer identity"));
        }
        Ok(())
    }
}
// No Debug: QR contains a short-lived bootstrap secret, never a long-lived key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub version: u8,
    pub id: String,
    pub peer: Peer,
    pub secret: String,
    pub expires_at: u64,
}
impl Drop for Invitation {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
impl Invitation {
    pub fn new(peer: Peer) -> Result<Self> {
        peer.validate()?;
        Ok(Self {
            version: VERSION,
            id: identifier()?,
            peer,
            secret: encode(Zeroizing::new(random::<32>()?).as_ref()),
            expires_at: now() + PAIR_TTL,
        })
    }
    pub fn parse(code: &str) -> Result<Self> {
        if code.len() > MAX_CONTROL {
            return Err(Error::Invalid("pairing code length"));
        }
        let value: Self = serde_json::from_str(code)?;
        value.validate()?;
        Ok(value)
    }
    pub fn validate(&self) -> Result<()> {
        self.peer.validate()?;
        decode::<16>(&self.id)?;
        let _key = Zeroizing::new(decode::<32>(&self.secret)?);
        if self.version != VERSION
            || self.expires_at <= now()
            || self.expires_at > now() + PAIR_TTL + 10
        {
            return Err(Error::Invalid("pairing code version or expiry"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mode {
    Pair { invitation_id: String },
    Session,
}
impl Mode {
    pub fn context(&self, host: &str) -> Result<Vec<u8>> {
        decode::<32>(host)?;
        if let Self::Pair { invitation_id } = self {
            decode::<16>(invitation_id)?;
        }
        Ok(serde_json::to_vec(&("agentport-e2ee/v1", host, self))?)
    }
}
// Only routing and handshake metadata is visible to the relay. The host access
// token is sent only over TLS (or loopback) and never enters a QR or diagnostic.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Registration {
    Host {
        public_key: String,
        access_token: Zeroizing<String>,
    },
    Accept {
        public_key: String,
        connection_id: String,
    },
    Join {
        host_id: String,
        mode: Mode,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Control {
    Ready,
    Incoming { connection_id: String, mode: Mode },
    Rejected { reason: Rejection },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rejection {
    Unauthorized,
    Offline,
    Busy,
    Invalid,
}
impl From<Rejection> for Error {
    fn from(value: Rejection) -> Self {
        match value {
            Rejection::Unauthorized => Self::Unauthorized,
            Rejection::Offline => Self::Offline,
            Rejection::Busy => Self::Busy,
            Rejection::Invalid => Self::Protocol,
        }
    }
}
pub fn registration_context(connection_id: Option<&str>) -> Result<Vec<u8>> {
    if let Some(id) = connection_id {
        decode::<16>(id)?;
    }
    Ok(serde_json::to_vec(&(
        "agentport-relay-registration/v1",
        connection_id,
    ))?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secure_endpoints_and_canonical_ids_are_required() {
        for url in [
            "ws://example.com/v1/relay",
            "wss://user:pass@example.com/v1/relay",
            "wss://example.com/v1/relay?token=secret",
            "https://example.com/v1/relay",
            "wss://example.com/other",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
        for url in [
            "wss://example.com/v1/relay",
            "ws://127.0.0.1:8765/v1/relay",
            "ws://[::1]:8765/v1/relay",
        ] {
            assert!(validate_url(url).is_ok(), "{url}");
        }
        assert!(decode::<32>("not-a-key").is_err());
    }
}
