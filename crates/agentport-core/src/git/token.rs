//! Process-private signing for renderer-visible opaque Git tokens.
//!
//! Repository keys are identifiers and are returned to the renderer, so they
//! must never double as signing secrets. Tokens intentionally expire when the
//! backend restarts; the renderer must obtain a new authoritative snapshot.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;

const HMAC_BLOCK_BYTES: usize = 64;

fn process_secret() -> &'static [u8; 32] {
    static SECRET: OnceLock<[u8; 32]> = OnceLock::new();
    SECRET.get_or_init(|| {
        let first = uuid::Uuid::new_v4();
        let second = uuid::Uuid::new_v4();
        let mut secret = [0_u8; 32];
        secret[..16].copy_from_slice(first.as_bytes());
        secret[16..].copy_from_slice(second.as_bytes());
        secret
    })
}

pub(crate) fn sign(domain: &[u8], parts: &[&[u8]]) -> String {
    URL_SAFE_NO_PAD.encode(mac(domain, parts))
}

pub(crate) fn verify(signature: &str, domain: &[u8], parts: &[&[u8]]) -> bool {
    let Ok(provided) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    let expected = mac(domain, parts);
    if provided.len() != expected.len() {
        return false;
    }
    provided
        .iter()
        .zip(expected)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn mac(domain: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut key = [0_u8; HMAC_BLOCK_BYTES];
    key[..process_secret().len()].copy_from_slice(process_secret());
    let mut inner_pad = [0x36_u8; HMAC_BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; HMAC_BLOCK_BYTES];
    for index in 0..HMAC_BLOCK_BYTES {
        inner_pad[index] ^= key[index];
        outer_pad[index] ^= key[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    update_message(&mut inner, domain, parts);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
}

fn update_message(hasher: &mut Sha256, domain: &[u8], parts: &[&[u8]]) {
    hasher.update((domain.len() as u64).to_be_bytes());
    hasher.update(domain);
    for part in parts {
        hasher.update((part.len() as u64).to_be_bytes());
        hasher.update(part);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signatures_are_domain_and_payload_bound() {
        let signature = sign(b"path", &[b"repo", b"file"]);
        assert!(verify(&signature, b"path", &[b"repo", b"file"]));
        assert!(!verify(&signature, b"cursor", &[b"repo", b"file"]));
        assert!(!verify(&signature, b"path", &[b"repo", b"other"]));
    }
}
