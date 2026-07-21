//! Stable ID generation (PRD ch.5 ID prefixes).

use chrono::Utc;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

const ALPHABET: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // crockford-ish, no I/L/O/U

fn encode(mut v: u64, len: usize) -> String {
    let mut buf = vec![0u8; len];
    for i in (0..len).rev() {
        buf[i] = ALPHABET[(v % 32) as usize];
        v /= 32;
    }
    String::from_utf8(buf).unwrap()
}

/// Time-ordered, process-unique id: `prefix_` + 10 chars time + 6 chars counter/random.
pub fn new_id(prefix: &str) -> String {
    let ms = Utc::now().timestamp_millis() as u64;
    let c = COUNTER.fetch_add(1, Ordering::Relaxed);
    let rand: u32 = rand_u32();
    let mixed = ((c as u32) << 20) ^ rand;
    format!("{prefix}_{}{}", encode(ms, 10), encode(mixed as u64, 6))
}

/// Random host token — 128-bit, hex. Never reused; part of session identity.
pub fn new_host_token() -> String {
    format!(
        "{:08x}{:08x}{:08x}{:08x}",
        rand_u32(),
        rand_u32(),
        rand_u32(),
        rand_u32()
    )
}

/// UUID v4 for CLIs that accept a caller-supplied session id (e.g. claude --session-id).
pub fn new_uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn rand_u32() -> u32 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    // RandomState is seeded from the OS RNG per instance; combine with time+counter.
    let s = RandomState::new();
    let mut h = s.build_hasher();
    h.write_u64(Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64);
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    (h.finish() >> 32) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ids_are_unique_and_prefixed() {
        let a = new_id("ses");
        let b = new_id("ses");
        assert!(a.starts_with("ses_"));
        assert_ne!(a, b);
        assert_eq!(new_host_token().len(), 32);
        uuid::Uuid::parse_str(&new_uuid()).unwrap();
    }
}
