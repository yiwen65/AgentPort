use crate::{
    protocol::{decode, encode, host_id, registration_context, Invitation, Mode, Peer, MAX_CIPHER},
    Error, Result,
};
use snow::{
    params::DHChoice,
    resolvers::{CryptoResolver, DefaultResolver},
    Builder, HandshakeState, TransportState,
};
use zeroize::Zeroizing;

const PAIR: &str = "Noise_XXpsk0_25519_ChaChaPoly_BLAKE2s";
const SESSION: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";
const REGISTRATION: &str = "Noise_NK_25519_ChaChaPoly_BLAKE2s";

/// Private identity bytes are held only by endpoints, never the relay server.
/// Native adapters persist them in the platform credential store.
pub struct Identity {
    private: Zeroizing<Vec<u8>>,
    public: [u8; 32],
}
impl Identity {
    pub fn generate() -> Result<Self> {
        let pair = Builder::new(SESSION.parse()?).generate_keypair()?;
        Self::from_private(Zeroizing::new(pair.private))
    }
    pub fn from_private(private: Zeroizing<Vec<u8>>) -> Result<Self> {
        if private.len() != 32 {
            return Err(Error::Invalid("identity key length"));
        }
        let mut dh = DefaultResolver
            .resolve_dh(&DHChoice::Curve25519)
            .ok_or(Error::Invalid("25519 provider"))?;
        dh.set(&private);
        let public = dh
            .pubkey()
            .try_into()
            .map_err(|_| Error::Invalid("identity public key"))?;
        Ok(Self { private, public })
    }
    pub fn private_bytes(&self) -> &[u8] {
        &self.private
    }
    pub fn public_bytes(&self) -> &[u8; 32] {
        &self.public
    }
    pub fn public_key(&self) -> String {
        encode(&self.public)
    }
    pub fn host_id(&self) -> String {
        host_id(&self.public)
    }
    pub fn peer(&self, relay_url: String, name: String) -> Result<Peer> {
        let peer = Peer {
            relay_url,
            name,
            public_key: self.public_key(),
            host_id: self.host_id(),
        };
        peer.validate()?;
        Ok(peer)
    }
}

pub struct Handshake {
    state: HandshakeState,
    expected: Option<[u8; 32]>,
}
impl Handshake {
    pub fn pair(identity: &Identity, invitation: &Invitation, initiator: bool) -> Result<Self> {
        invitation.validate()?;
        let expected = decode::<32>(&invitation.peer.public_key)?;
        if !initiator && identity.public != expected {
            return Err(Error::Unauthorized);
        }
        let psk = Zeroizing::new(decode::<32>(&invitation.secret)?);
        let context = Mode::Pair {
            invitation_id: invitation.id.clone(),
        }
        .context(&invitation.peer.host_id)?;
        let builder = Builder::new(PAIR.parse()?)
            .local_private_key(&identity.private)?
            .psk(0, &psk)?
            .prologue(&context)?;
        Ok(Self {
            state: if initiator {
                builder.build_initiator()?
            } else {
                builder.build_responder()?
            },
            expected: initiator.then_some(expected),
        })
    }
    pub fn session(identity: &Identity, peer: &Peer, initiator: bool) -> Result<Self> {
        peer.validate()?;
        let remote = decode::<32>(&peer.public_key)?;
        if !initiator && remote != identity.public {
            return Err(Error::Unauthorized);
        }
        let context = Mode::Session.context(&peer.host_id)?;
        let mut builder = Builder::new(SESSION.parse()?)
            .local_private_key(&identity.private)?
            .prologue(&context)?;
        if initiator {
            builder = builder.remote_public_key(&remote)?;
        }
        Ok(Self {
            state: if initiator {
                builder.build_initiator()?
            } else {
                builder.build_responder()?
            },
            expected: initiator.then_some(remote),
        })
    }
    /// Relay verifies possession of the registered computer's X25519 key using
    /// a fresh Noise NK challenge. No second signing key or relay key database.
    pub fn registration_challenge(public_key: &str, connection_id: Option<&str>) -> Result<Self> {
        let remote = decode::<32>(public_key)?;
        let context = registration_context(connection_id)?;
        Ok(Self {
            state: Builder::new(REGISTRATION.parse()?)
                .remote_public_key(&remote)?
                .prologue(&context)?
                .build_initiator()?,
            expected: Some(remote),
        })
    }
    pub fn registration_response(identity: &Identity, connection_id: Option<&str>) -> Result<Self> {
        let context = registration_context(connection_id)?;
        Ok(Self {
            state: Builder::new(REGISTRATION.parse()?)
                .local_private_key(&identity.private)?
                .prologue(&context)?
                .build_responder()?,
            expected: None,
        })
    }
    pub fn write(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        if plaintext.len() > 2048 {
            return Err(Error::Invalid("handshake payload length"));
        }
        let mut bytes = vec![0; MAX_CIPHER];
        let n = self.state.write_message(plaintext, &mut bytes)?;
        bytes.truncate(n);
        Ok(bytes)
    }
    pub fn read(&mut self, bytes: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        if bytes.len() > 4096 {
            return Err(Error::Invalid("handshake frame length"));
        }
        let mut plaintext = Zeroizing::new(vec![0; 4096]);
        let n = self.state.read_message(bytes, &mut plaintext)?;
        // Pin as soon as the remote static key is authenticated, before the
        // initiator sends the phone identity/name in the final pairing message.
        if let (Some(expected), Some(actual)) = (self.expected, self.state.get_remote_static()) {
            if actual != expected {
                return Err(Error::Unauthorized);
            }
        }
        plaintext.truncate(n);
        Ok(plaintext)
    }
    pub fn remote_key(&self) -> Result<[u8; 32]> {
        let key = self.state.get_remote_static().ok_or(Error::Unauthorized)?;
        key.try_into().map_err(|_| Error::Unauthorized)
    }
    pub fn finish(self) -> Result<Established> {
        if !self.state.is_handshake_finished() {
            return Err(Error::Protocol);
        }
        if let Some(expected) = self.expected {
            if self.remote_key()? != expected {
                return Err(Error::Unauthorized);
            }
        }
        let hash = self.state.get_handshake_hash();
        let verification_code = format!(
            "{:02X}{:02X}-{:02X}{:02X}",
            hash[0], hash[1], hash[2], hash[3]
        );
        let remote_key = self.state.get_remote_static().map(encode);
        Ok(Established {
            cipher: self.state.into_transport_mode()?,
            verification_code,
            remote_key,
        })
    }
}
pub struct Established {
    pub cipher: TransportState,
    pub verification_code: String,
    pub remote_key: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Identity, Identity, Invitation) {
        let host = Identity::generate().unwrap();
        let phone = Identity::generate().unwrap();
        let invitation = Invitation::new(
            host.peer("ws://127.0.0.1/v1/relay".into(), "Test computer".into())
                .unwrap(),
        )
        .unwrap();
        (host, phone, invitation)
    }
    fn paired() -> (Established, Established) {
        let (host, phone, inv) = fixture();
        let mut a = Handshake::pair(&phone, &inv, true).unwrap();
        let mut b = Handshake::pair(&host, &inv, false).unwrap();
        assert!(b.read(&a.write(&[]).unwrap()).unwrap().is_empty());
        a.read(&b.write(&[]).unwrap()).unwrap();
        assert_eq!(
            b.read(&a.write(b"Test phone").unwrap()).unwrap().as_slice(),
            b"Test phone"
        );
        let a = a.finish().unwrap();
        let b = b.finish().unwrap();
        assert_eq!(a.remote_key, Some(host.public_key()));
        assert_eq!(b.remote_key, Some(phone.public_key()));
        assert_eq!(a.verification_code, b.verification_code);
        (a, b)
    }
    #[test]
    fn pairing_binds_both_identities_and_ciphertext_replay_is_rejected() {
        let (mut a, mut b) = paired();
        let mut bytes = [0; 128];
        let n = a
            .cipher
            .write_message(b"terminal-private-content", &mut bytes)
            .unwrap();
        assert!(!String::from_utf8_lossy(&bytes[..n]).contains("terminal-private-content"));
        let mut plain = [0; 128];
        let count = b.cipher.read_message(&bytes[..n], &mut plain).unwrap();
        assert_eq!(&plain[..count], b"terminal-private-content");
        assert!(b.cipher.read_message(&bytes[..n], &mut plain).is_err());
    }
    #[test]
    fn tampered_ciphertext_wrong_psk_and_wrong_computer_fail_closed() {
        let (mut a, mut b) = paired();
        let mut bytes = [0; 128];
        let n = a.cipher.write_message(b"secret", &mut bytes).unwrap();
        bytes[n - 1] ^= 1;
        assert!(b.cipher.read_message(&bytes[..n], &mut [0; 128]).is_err());
        let (host, phone, inv) = fixture();
        let mut wrong = inv.clone();
        wrong.secret = encode(&[7; 32]);
        let mut a = Handshake::pair(&phone, &wrong, true).unwrap();
        let mut b = Handshake::pair(&host, &inv, false).unwrap();
        assert!(b.read(&a.write(&[]).unwrap()).is_err());
        assert!(Handshake::pair(&phone, &inv, false).is_err());
        let mut wrong = inv.clone();
        wrong.id = crate::protocol::identifier().unwrap();
        let mut a = Handshake::pair(&phone, &wrong, true).unwrap();
        let mut b = Handshake::pair(&host, &inv, false).unwrap();
        assert!(b.read(&a.write(&[]).unwrap()).is_err());
    }
    #[test]
    fn pairing_rejects_wrong_computer_before_disclosing_phone_identity() {
        let (_, phone, inv) = fixture();
        let attacker = Identity::generate().unwrap();
        // Even an attacker with the QR PSK cannot replace its pinned computer.
        let psk = Zeroizing::new(decode::<32>(&inv.secret).unwrap());
        let context = Mode::Pair {
            invitation_id: inv.id.clone(),
        }
        .context(&inv.peer.host_id)
        .unwrap();
        let mut responder = Builder::new(PAIR.parse().unwrap())
            .local_private_key(attacker.private_bytes())
            .unwrap()
            .psk(0, &psk)
            .unwrap()
            .prologue(&context)
            .unwrap()
            .build_responder()
            .unwrap();
        let mut initiator = Handshake::pair(&phone, &inv, true).unwrap();
        responder
            .read_message(&initiator.write(&[]).unwrap(), &mut [0; 4096])
            .unwrap();
        let mut reply = [0; 4096];
        let size = responder.write_message(&[], &mut reply).unwrap();
        assert!(matches!(
            initiator.read(&reply[..size]),
            Err(Error::Unauthorized)
        ));
        assert!(responder.get_remote_static().is_none());
    }
    #[test]
    fn session_auth_exposes_phone_identity_before_computer_acceptance() {
        let (host, phone, inv) = fixture();
        let mut a = Handshake::session(&phone, &inv.peer, true).unwrap();
        let mut b = Handshake::session(&host, &inv.peer, false).unwrap();
        b.read(&a.write(&[]).unwrap()).unwrap();
        assert_eq!(b.remote_key().unwrap(), *phone.public_bytes());
        assert!(!b.state.is_handshake_finished()); // Endpoint must check allowlist before replying.
        a.read(&b.write(&[]).unwrap()).unwrap();
        a.finish().unwrap();
        b.finish().unwrap();
    }
    #[test]
    fn registration_proves_private_key_and_cannot_replay_across_challenges_or_operations() {
        let host = Identity::generate().unwrap();
        let mut relay = Handshake::registration_challenge(&host.public_key(), None).unwrap();
        let mut endpoint = Handshake::registration_response(&host, None).unwrap();
        let challenge = relay.write(&[]).unwrap();
        endpoint.read(&challenge).unwrap();
        let response = endpoint.write(&[]).unwrap();
        relay.read(&response).unwrap();
        relay.finish().unwrap();
        let mut next = Handshake::registration_challenge(&host.public_key(), None).unwrap();
        next.write(&[]).unwrap();
        assert!(next.read(&response).is_err());
        let id = crate::protocol::identifier().unwrap();
        let mut other_op = Handshake::registration_response(&host, Some(&id)).unwrap();
        assert!(other_op.read(&challenge).is_err());
    }
    #[test]
    fn expired_or_rewritten_invitations_are_not_accepted() {
        let (_, phone, inv) = fixture();
        let mut expired = inv.clone();
        expired.expires_at = crate::protocol::now();
        assert!(Handshake::pair(&phone, &expired, true).is_err());
        let mut future = inv.clone();
        future.expires_at += 3600;
        assert!(future.validate().is_err());
        let mut wrong = inv.clone();
        wrong.peer.host_id = phone.host_id();
        assert!(wrong.validate().is_err());
        let mut version = inv.clone();
        version.version += 1;
        assert!(version.validate().is_err());
        assert!(Invitation::parse(&serde_json::to_string(&expired).unwrap()).is_err());
    }
}
