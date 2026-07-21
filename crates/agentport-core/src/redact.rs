//! Secret redaction (PRD 3.7 failure path C): any byte sequence matching a
//! secret value is replaced with a fixed mask BEFORE data hits disk, exports or
//! the search index. Only hit counts/types are recorded — never the value.

/// Fixed mask; length-independent of the secret.
pub const MASK: &[u8] = b"[redacted]";
/// Secrets shorter than this are not fingerprinted (masking a 1-3 byte string
/// would corrupt normal output); such values are rejected at store time.
pub const MIN_SECRET_LEN: usize = 4;

pub struct Redactor {
    secrets: Vec<Vec<u8>>,
    /// Withheld tail that may be the prefix of a secret spanning chunks.
    pending: Vec<u8>,
    hits: u64,
}

impl Redactor {
    pub fn new(secrets: Vec<Vec<u8>>) -> Self {
        let secrets: Vec<Vec<u8>> = secrets
            .into_iter()
            .filter(|s| s.len() >= MIN_SECRET_LEN)
            .collect();
        Redactor {
            secrets,
            pending: Vec::new(),
            hits: 0,
        }
    }

    pub fn hits(&self) -> u64 {
        self.hits
    }
    pub fn is_active(&self) -> bool {
        !self.secrets.is_empty()
    }

    /// Feed a chunk; returns bytes safe to persist. Complete matches are
    /// replaced immediately; the only withheld bytes are the longest suffix
    /// that is a proper prefix of some secret (it may complete on the next
    /// chunk). Everything else is safe: a secret starting in the emitted
    /// region would either be complete (already replaced) or require such a
    /// suffix (withheld). No artificial tail starvation — interactive bursts
    /// are emitted fully unless they genuinely end mid-secret.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<u8> {
        if self.secrets.is_empty() {
            return chunk.to_vec();
        }
        self.pending.extend_from_slice(chunk);
        self.hits += replace_all(&mut self.pending, &self.secrets);
        let hold = self.hold_len();
        if hold == self.pending.len() {
            return Vec::new();
        }
        let emit_upto = self.pending.len() - hold;
        let out = self.pending[..emit_upto].to_vec();
        self.pending.drain(..emit_upto);
        out
    }

    /// Longest suffix of `pending` that is a proper prefix of any secret.
    fn hold_len(&self) -> usize {
        let mut best = 0usize;
        for s in &self.secrets {
            let max = s.len().min(self.pending.len());
            let mut l = max;
            while l > best {
                if self.pending.ends_with(&s[..l]) {
                    best = l;
                    break;
                }
                l -= 1;
            }
        }
        best
    }

    /// Flush remaining withheld bytes (end of stream). All remaining matches
    /// are complete now, so the whole buffer is safe to emit after redaction.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = std::mem::take(&mut self.pending);
        self.hits += replace_all(&mut out, &self.secrets);
        out
    }
}

/// One-shot redaction for exports/indexing.
pub fn redact_bytes(data: &[u8], secrets: &[Vec<u8>]) -> (Vec<u8>, u64) {
    let secrets: Vec<Vec<u8>> = secrets
        .iter()
        .filter(|s| s.len() >= MIN_SECRET_LEN)
        .cloned()
        .collect();
    let mut out = data.to_vec();
    let hits = replace_all(&mut out, &secrets);
    (out, hits)
}

fn replace_all(buf: &mut Vec<u8>, secrets: &[Vec<u8>]) -> u64 {
    let mut hits = 0u64;
    for secret in secrets {
        loop {
            match find_subslice(buf, secret) {
                Some(pos) => {
                    buf.splice(pos..pos + secret.len(), MASK.iter().copied());
                    hits += 1;
                }
                None => break,
            }
        }
    }
    hits
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_shot_masks_every_occurrence() {
        let (out, hits) = redact_bytes(b"a SECRET123 b SECRET123", &[b"SECRET123".to_vec()]);
        assert_eq!(hits, 2);
        assert_eq!(out, b"a [redacted] b [redacted]");
    }

    #[test]
    fn streaming_catches_boundary_spanning_secret() {
        let mut r = Redactor::new(vec![b"hunter2hunter2".to_vec()]);
        let mut out = r.feed(b"prefix hunt");
        out.extend(r.feed(b"er2hunter2 suffix"));
        out.extend(r.finish());
        let s = String::from_utf8(out).unwrap();
        assert!(!s.contains("hunter2hunter2"));
        assert!(s.contains("[redacted]"));
        assert_eq!(r.hits(), 1);
    }

    #[test]
    fn short_secrets_ignored_and_passthrough_when_none() {
        let mut r = Redactor::new(vec![b"ab".to_vec()]);
        assert_eq!(r.feed(b"hello"), b"hello");
        let (out, hits) = redact_bytes(b"ab ab", &[b"ab".to_vec()]);
        assert_eq!((out, hits), (b"ab ab".to_vec(), 0));
    }

    #[test]
    fn no_tail_starvation_for_interactive_output() {
        // Regression: the redactor must not hold back ordinary tail bytes —
        // interactive prompts after a secret must appear immediately.
        let mut r = Redactor::new(vec![b"supersecret123".to_vec()]);
        let out1 = r.feed(b"child=supersecret123\r\ndone\r\n$ ");
        // "child=[redacted]\r\ndone\r\n$ " — nothing here is a prefix of the
        // secret, so everything is emitted at once.
        let s = String::from_utf8(out1).unwrap();
        assert!(s.contains("done"), "got {s:?}");
        assert!(s.contains("[redacted]"));
        assert!(!s.contains("supersecret123"));
        assert_eq!(r.finish(), b"");
    }

    #[test]
    fn boundary_prefix_is_held_then_completed() {
        let mut r = Redactor::new(vec![b"abc123def".to_vec()]);
        // Tail "abc123" is a proper prefix of the secret -> withheld.
        let out1 = r.feed(b"value=abc123");
        assert_eq!(out1, b"value=");
        // Next chunk completes the secret -> masked, and no leak.
        let out2 = r.feed(b"def ok");
        let s = String::from_utf8(out2).unwrap();
        assert!(s.contains("[redacted]"));
        assert!(!s.contains("abc123def"));
    }
}
