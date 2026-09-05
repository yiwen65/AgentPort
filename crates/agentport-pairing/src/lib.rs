//! Short-lived QR bootstrap only. Normal connections remain authenticated SSH.
//! The QR carries an ephemeral 256-bit capability, never an SSH private key.
//! Every network message is AES-256-GCM authenticated with direction/id AAD.
mod authorized_keys;
mod server;
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
pub use authorized_keys::{authorize, devices, revoke, PairedDevice};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use serde::{Deserialize, Serialize};
pub use server::{exchange, PairingServer, PairingStatus};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::{Zeroize, Zeroizing};

pub type Result<T> = std::result::Result<T, String>;
pub const TTL_SECONDS: u64 = 120;
pub const MAX_MESSAGE: usize = 8192;
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn random_id() -> Result<String> {
    let mut bytes = [0; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| "Random generator unavailable")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshTarget {
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub fingerprint: String,
}
impl SshTarget {
    pub fn validate(&self) -> Result<()> {
        if self.name.is_empty()
            || self.name.len() > 100
            || self.name.chars().any(char::is_control)
            || !valid_host(&self.hostname)
            || self.port == 0
            || self.username.is_empty()
            || self.username.len() > 64
            || !self
                .username
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            || !self.fingerprint.starts_with("SHA256:")
            || self.fingerprint.len() != 50
        {
            return Err("Invalid SSH pairing target".into());
        }
        Ok(())
    }
}
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-:_".contains(&b))
}
fn valid_id(id: &str) -> bool {
    id.len() == 22
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}

// Deliberately no Debug: invitations contain a temporary secret.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invitation {
    pub version: u8,
    pub id: String,
    pub address: String,
    pub port: u16,
    pub secret: String,
    pub expires_at: u64,
    pub ssh: SshTarget,
}
impl Drop for Invitation {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}
impl Invitation {
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() > 2048 {
            return Err("Pairing code is too large".into());
        }
        let invitation: Self =
            serde_json::from_str(text).map_err(|_| "Invalid AgentPort pairing code")?;
        invitation.validate()?;
        Ok(invitation)
    }
    pub fn validate(&self) -> Result<()> {
        if self.version != 1 || !valid_id(&self.id) || !valid_host(&self.address) || self.port == 0
        {
            return Err("Unsupported or invalid pairing code".into());
        }
        if self.expires_at <= now() || self.expires_at > now() + TTL_SECONDS + 10 {
            return Err("Pairing code expired; generate a new code on the computer".into());
        }
        self.key()?;
        self.ssh.validate()
    }
    fn key(&self) -> Result<Zeroizing<Vec<u8>>> {
        let key = Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(&self.secret)
                .map_err(|_| "Invalid pairing capability")?,
        );
        if key.len() != 32 {
            return Err("Invalid pairing capability".into());
        }
        Ok(key)
    }
    fn aad(&self, direction: &str) -> Vec<u8> {
        format!("agentport-pairing/v1/{}/{direction}", self.id).into_bytes()
    }
    pub(crate) fn seal<T: Serialize>(&self, direction: &str, value: &T) -> Result<Vec<u8>> {
        self.validate()?;
        let mut nonce = [0_u8; 12];
        getrandom::getrandom(&mut nonce).map_err(|_| "Random generator unavailable")?;
        let plaintext =
            Zeroizing::new(serde_json::to_vec(value).map_err(|_| "Invalid pairing message")?);
        if plaintext.len() > MAX_MESSAGE - 28 {
            return Err("Pairing message is too large".into());
        }
        let encrypted = Aes256Gcm::new_from_slice(&self.key()?)
            .map_err(|_| "Invalid pairing capability")?
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: &self.aad(direction),
                },
            )
            .map_err(|_| "Pairing encryption failed")?;
        Ok([nonce.as_slice(), &encrypted].concat())
    }
    pub(crate) fn open<T: for<'de> Deserialize<'de>>(
        &self,
        direction: &str,
        bytes: &[u8],
    ) -> Result<T> {
        self.validate()?;
        if bytes.len() < 28 || bytes.len() > MAX_MESSAGE {
            return Err("Invalid pairing message length".into());
        }
        let plaintext = Zeroizing::new(
            Aes256Gcm::new_from_slice(&self.key()?)
                .map_err(|_| "Invalid pairing capability")?
                .decrypt(
                    Nonce::from_slice(&bytes[..12]),
                    Payload {
                        msg: &bytes[12..],
                        aad: &self.aad(direction),
                    },
                )
                .map_err(|_| "Pairing message authentication failed")?,
        );
        serde_json::from_slice(&plaintext).map_err(|_| "Invalid pairing message".into())
    }
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingRequest {
    pub request_id: String,
    pub device_name: String,
    pub public_key: String,
}
impl PairingRequest {
    pub fn validate(&self) -> Result<()> {
        if !valid_id(&self.request_id)
            || self.device_name.is_empty()
            || self.device_name.len() > 80
            || self.device_name.chars().any(char::is_control)
        {
            return Err("Invalid requesting device".into());
        }
        public_key_fingerprint(&self.public_key)?;
        Ok(())
    }
    pub fn verification_code(&self, invitation: &Invitation) -> String {
        // Both screens bind approval to this exact key, not just a spoofable name.
        let digest = Sha256::digest(format!(
            "{}:{}:{}",
            invitation.id, self.request_id, self.public_key
        ));
        format!(
            "{:02X}{:02X}-{:02X}{:02X}",
            digest[0], digest[1], digest[2], digest[3]
        )
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingReply {
    pub request_id: String,
    pub state: String,
    pub ssh: Option<SshTarget>,
}

pub fn public_key_fingerprint(key: &str) -> Result<String> {
    if key.len() > 1024 || key.contains(['\r', '\n']) {
        return Err("Invalid SSH public key".into());
    }
    let fields: Vec<_> = key.split_whitespace().collect();
    if fields.len() != 2 || fields[0] != "ssh-ed25519" {
        return Err("Only a plain Ed25519 public key is accepted".into());
    }
    let blob = STANDARD
        .decode(fields[1])
        .map_err(|_| "Invalid SSH public key")?;
    if blob.len() != 51 || &blob[..19] != b"\0\0\0\x0bssh-ed25519\0\0\0\x20" {
        return Err("Invalid Ed25519 public key encoding".into());
    }
    Ok(format!(
        "SHA256:{}",
        STANDARD.encode(Sha256::digest(&blob)).trim_end_matches('=')
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn key() -> String {
        format!(
            "ssh-ed25519 {}",
            STANDARD.encode([b"\0\0\0\x0bssh-ed25519\0\0\0\x20".as_slice(), &[7; 32]].concat())
        )
    }
    pub fn invitation() -> Invitation {
        Invitation {
            version: 1,
            id: random_id().unwrap(),
            address: "127.0.0.1".into(),
            port: 1234,
            secret: URL_SAFE_NO_PAD.encode([8; 32]),
            expires_at: now() + TTL_SECONDS,
            ssh: SshTarget {
                name: "Test".into(),
                hostname: "localhost".into(),
                port: 22,
                username: "test".into(),
                fingerprint: public_key_fingerprint(&key()).unwrap(),
            },
        }
    }
    #[test]
    fn tampering_wrong_direction_and_wrong_capability_fail_closed() {
        let inv = invitation();
        let request = PairingRequest {
            request_id: random_id().unwrap(),
            device_name: "Phone".into(),
            public_key: key(),
        };
        let body = inv.seal("request", &request).unwrap();
        assert!(!String::from_utf8_lossy(&body).contains("ssh-ed25519"));
        assert!(inv.open::<PairingRequest>("reply", &body).is_err());
        let mut wrong = inv.clone();
        wrong.secret = URL_SAFE_NO_PAD.encode([9; 32]);
        assert!(wrong.open::<PairingRequest>("request", &body).is_err());
        let mut corrupted = body.clone();
        corrupted[20] ^= 1;
        assert!(inv.open::<PairingRequest>("request", &corrupted).is_err());
        assert_eq!(
            inv.open::<PairingRequest>("request", &body)
                .unwrap()
                .public_key,
            request.public_key
        );
    }
    #[test]
    fn invalid_keys_and_expired_codes_are_rejected() {
        assert!(public_key_fingerprint(&(key() + "\ncommand=malicious")).is_err());
        assert!(public_key_fingerprint("ssh-ed25519 AAAA").is_err());
        let mut inv = invitation();
        inv.expires_at = now();
        assert!(inv.validate().is_err());
    }
}
