use std::time::{Duration, Instant};

/// Coalesces small PTY reads without allowing a DEC 2026 synchronized redraw
/// to be emitted as several independently paintable writes.
pub(crate) struct OutputBatcher {
    bytes: Vec<u8>,
    marker: Vec<u8>,
    synchronized: bool,
    pending_since: Option<Instant>,
    sync_since: Option<Instant>,
}

/// How long the PTY reader may wait for the next read before pending bytes must
/// be released. A blocking read cannot wake the batcher itself, so the reader
/// loop uses this as its receive timeout.
pub(crate) const IDLE_WAIT: Duration = Duration::from_millis(4);

const TARGET_BYTES: usize = 8 * 1024;
/// Host NDJSON frames are capped at 1 MiB and Output data is base64 encoded
/// inside them. One PTY read is already up to 256 KiB, so a batch must never
/// grow past that even while a synchronized frame spans several reads.
const MAX_BATCH_BYTES: usize = 256 * 1024;
const MAX_WAIT: Duration = IDLE_WAIT;
/// An unmatched DEC 2026 begin must not hold output forever.
const MAX_SYNC_WAIT: Duration = Duration::from_millis(100);
const BEGIN: &[u8] = b"\x1b[?2026h";
const END: &[u8] = b"\x1b[?2026l";
const RESET: &[u8] = b"\x1bc";

impl OutputBatcher {
    pub(crate) fn new() -> Self {
        Self {
            bytes: Vec::with_capacity(TARGET_BYTES),
            marker: Vec::with_capacity(BEGIN.len()),
            synchronized: false,
            pending_since: None,
            sync_since: None,
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
        let closed = self.scan(data, now);
        let waited = self
            .pending_since
            .is_some_and(|since| now.saturating_duration_since(since) >= MAX_WAIT);
        let should_flush = closed
            || self.bytes.len() >= MAX_BATCH_BYTES
            || (!self.synchronized && (self.bytes.len() >= TARGET_BYTES || waited));
        if should_flush { self.take(now) } else { Vec::new() }
    }

    /// Releases bytes that would otherwise wait for another PTY read. The
    /// caller invokes this after `IDLE_WAIT` without input; an open
    /// synchronized frame still gets one bounded grace period before a partial
    /// release, because a truncated marker must not freeze the stream.
    pub(crate) fn flush_idle(&mut self, now: Instant) -> Vec<Vec<u8>> {
        if self.bytes.is_empty() {
            return Vec::new();
        }
        if self.synchronized
            && self
                .sync_since
                .is_some_and(|since| now.saturating_duration_since(since) < MAX_SYNC_WAIT)
        {
            return Vec::new();
        }
        self.take(now)
    }

    pub(crate) fn flush(&mut self, now: Instant) -> Vec<Vec<u8>> {
        if self.bytes.is_empty() {
            return Vec::new();
        }
        self.take(now)
    }

    fn take(&mut self, now: Instant) -> Vec<Vec<u8>> {
        self.pending_since = None;
        self.sync_since = self.synchronized.then_some(now);
        let bytes = std::mem::take(&mut self.bytes);
        bytes.chunks(MAX_BATCH_BYTES).map(<[u8]>::to_vec).collect()
    }

    /// Returns true when a synchronized frame ended in this input.
    fn scan(&mut self, data: &[u8], now: Instant) -> bool {
        let mut closed = false;
        for &byte in data {
            if self.marker.is_empty() {
                if byte == 0x1b { self.marker.push(byte); }
                continue;
            }
            self.marker.push(byte);
            let is_begin_prefix = BEGIN.starts_with(&self.marker);
            let is_end_prefix = END.starts_with(&self.marker);
            let is_reset_prefix = RESET.starts_with(&self.marker);
            if is_begin_prefix || is_end_prefix || is_reset_prefix {
                if self.marker == BEGIN {
                    self.synchronized = true;
                    self.sync_since.get_or_insert(now);
                    self.marker.clear();
                } else if self.marker == END {
                    self.synchronized = false;
                    self.sync_since = None;
                    self.marker.clear();
                    closed = true;
                } else if self.marker == RESET {
                    closed |= self.synchronized;
                    self.synchronized = false;
                    self.sync_since = None;
                    self.marker.clear();
                }
                continue;
            }
            // The candidate was not a marker. Preserve a trailing ESC as the
            // start of a new candidate; all other bytes are ordinary output.
            self.marker.clear();
            if byte == 0x1b { self.marker.push(byte); }
        }
        closed
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
        assert_eq!(b.flush_idle(at(5)).concat(), b"prompt> ");
        assert!(b.flush_idle(at(6)).is_empty());
    }

    #[test]
    fn keeps_a_split_dec_frame_in_one_batch() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"before\x1b[?2026hrow", at(10)).is_empty());
        assert!(b.push(b" two\x1b[?2026lafter", at(11)).len() == 1);
        assert_eq!(b.flush(at(12)).concat(), b"");
    }

    #[test]
    fn releases_an_unmatched_dec_frame_after_the_sync_grace() {
        let base = Instant::now();
        let mut b = OutputBatcher::new();
        assert!(b.push(b"\x1b[?2026hrow", base).is_empty());
        assert!(b
            .flush_idle(base + MAX_SYNC_WAIT - Duration::from_millis(1))
            .is_empty());
        assert_eq!(
            b.flush_idle(base + MAX_SYNC_WAIT + Duration::from_millis(1))
                .concat(),
            b"\x1b[?2026hrow"
        );
    }

    #[test]
    fn caps_synchronized_batches_below_the_protocol_limit() {
        let mut b = OutputBatcher::new();
        let mut input = BEGIN.to_vec();
        input.extend(std::iter::repeat_n(b'x', MAX_BATCH_BYTES));
        let batches = b.push(&input, at(1));
        assert!(batches.len() > 1);
        assert!(batches.iter().all(|batch| batch.len() <= MAX_BATCH_BYTES));
        assert_eq!(batches.concat(), input);
        assert_eq!(b.push(END, at(2)).concat(), END);
    }

    #[test]
    fn reset_releases_an_open_synchronized_frame() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"\x1b[?2026hpartial", at(1)).is_empty());
        assert_eq!(b.push(RESET, at(2)).concat(), b"\x1b[?2026hpartial\x1bc");
    }

    #[test]
    fn recognizes_markers_split_at_every_byte() {
        let mut b = OutputBatcher::new();
        let frame = b"\x1b[?2026hFULL\x1b[?2026l";
        let mut output = Vec::new();
        for byte in frame { output.extend(b.push(&[*byte], at(1))); }
        output.extend(b.flush(at(2)));
        assert_eq!(output.concat(), frame);
    }

    #[test]
    fn preserves_bytes_and_flushes_eof() {
        let mut b = OutputBatcher::new();
        assert!(b.push(b"one", at(1)).is_empty());
        assert_eq!(b.flush(at(2)).concat(), b"one");
        assert!(b.flush(at(3)).is_empty());
    }
}
