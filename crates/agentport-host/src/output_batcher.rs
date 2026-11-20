use std::time::{Duration, Instant};

/// Coalesces small PTY reads into bounded batches so a fullscreen TUI does not
/// produce one remote frame per write. DEC 2026 atomicity is enforced by the
/// client renderers; holding a synchronized frame here only creates bursts and
/// lets an unmatched begin marker stall the stream.
pub(crate) struct OutputBatcher {
    bytes: Vec<u8>,
    pending_since: Option<Instant>,
}

/// How long the PTY reader may wait for the next read before pending bytes must
/// be released. A blocking read cannot wake the batcher itself, so the reader
/// loop uses this as its receive timeout.
pub(crate) const IDLE_WAIT: Duration = Duration::from_millis(4);

const TARGET_BYTES: usize = 8 * 1024;
/// Host NDJSON frames are capped at 1 MiB and Output data is base64 encoded
/// inside them. One PTY read is already up to 256 KiB, so a batch must never
/// grow past that.
const MAX_BATCH_BYTES: usize = 256 * 1024;
const MAX_WAIT: Duration = IDLE_WAIT;

impl OutputBatcher {
    pub(crate) fn new() -> Self {
        Self {
            bytes: Vec::with_capacity(TARGET_BYTES),
            pending_since: None,
        }
    }

    pub(crate) fn push(&mut self, data: &[u8], now: Instant) -> Vec<Vec<u8>> {
        if data.is_empty() {
            return Vec::new();
        }
        if self.bytes.is_empty() {
            self.pending_since = Some(now);
        }
        self.bytes.extend_from_slice(data);
        let waited = self
            .pending_since
            .is_some_and(|since| now.saturating_duration_since(since) >= MAX_WAIT);
        if self.bytes.len() >= MAX_BATCH_BYTES
            || self.bytes.len() >= TARGET_BYTES
            || waited
        {
            self.take()
        } else {
            Vec::new()
        }
    }

    /// Releases bytes that would otherwise wait for another PTY read. The
    /// caller invokes this after `IDLE_WAIT` without input.
    pub(crate) fn flush_idle(&mut self) -> Vec<Vec<u8>> {
        if self.bytes.is_empty() {
            Vec::new()
        } else {
            self.take()
        }
    }

    pub(crate) fn flush(&mut self) -> Vec<Vec<u8>> {
        self.flush_idle()
    }

    fn take(&mut self) -> Vec<Vec<u8>> {
        self.pending_since = None;
        let bytes = std::mem::take(&mut self.bytes);
        bytes.chunks(MAX_BATCH_BYTES).map(<[u8]>::to_vec).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(ms: u64) -> Instant { Instant::now() + Duration::from_millis(ms) }

    #[test]
    fn coalesces_small_reads_at_target_size() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"a", at(1)).is_empty());
        assert!(b.push(&vec![b'b'; TARGET_BYTES - 1], at(2)).len() == 1);
    }

    #[test]
    fn flushes_after_the_bounded_wait() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"a", at(1)).is_empty());
        assert_eq!(b.push(b"b", at(5)).concat(), b"ab");
    }

    #[test]
    fn flushes_a_trailing_batch_after_reader_idle() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"prompt> ", at(1)).is_empty());
        assert_eq!(b.flush_idle().concat(), b"prompt> ");
        assert!(b.flush_idle().is_empty());
    }

    #[test]
    fn keeps_synchronized_frames_bounded_without_waiting_for_an_end_marker() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"\x1b[?2026hrow", at(1)).is_empty());
        assert_eq!(b.push(b" more", at(5)).concat(), b"\x1b[?2026hrow more");
    }

    #[test]
    fn caps_batches_below_the_protocol_limit() {
        let mut b = OutputBatcher::new();
        let input = vec![b'x'; MAX_BATCH_BYTES + 17];
        let batches = b.push(&input, at(1));
        assert!(batches.len() > 1);
        assert!(batches.iter().all(|batch| batch.len() <= MAX_BATCH_BYTES));
        assert_eq!(batches.concat(), input);
    }

    #[test]
    fn preserves_bytes_and_flushes_eof() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"one", at(1)).is_empty());
        assert_eq!(b.flush().concat(), b"one");
        assert!(b.flush().is_empty());
    }
}
