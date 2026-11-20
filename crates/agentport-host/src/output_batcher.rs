use std::time::{Duration, Instant};

/// Coalesces small PTY reads without allowing a DEC 2026 synchronized redraw
/// to be emitted as several independently paintable writes.
pub(crate) struct OutputBatcher {
    bytes: Vec<u8>,
    marker: Vec<u8>,
    synchronized: bool,
    last_flush: Instant,
}

const TARGET_BYTES: usize = 8 * 1024;
const MAX_WAIT: Duration = Duration::from_millis(4);
const BEGIN: &[u8] = b"\x1b[?2026h";
const END: &[u8] = b"\x1b[?2026l";

impl OutputBatcher {
    pub(crate) fn new(now: Instant) -> Self {
        Self {
            bytes: Vec::with_capacity(TARGET_BYTES),
            marker: Vec::with_capacity(BEGIN.len()),
            synchronized: false,
            last_flush: now,
        }
    }

    pub(crate) fn push(&mut self, data: &[u8], now: Instant) -> Vec<Vec<u8>> {
        self.bytes.extend_from_slice(data);
        let closed = self.scan(data);
        let timed_out = now.saturating_duration_since(self.last_flush) >= MAX_WAIT;
        let should_flush = closed
            || (!self.synchronized && (self.bytes.len() >= TARGET_BYTES || timed_out));
        if should_flush { self.take(now) } else { Vec::new() }
    }

    pub(crate) fn flush(&mut self, now: Instant) -> Vec<Vec<u8>> {
        if self.bytes.is_empty() { return Vec::new(); }
        self.take(now)
    }

    fn take(&mut self, now: Instant) -> Vec<Vec<u8>> {
        self.last_flush = now;
        self.marker.clear();
        vec![std::mem::take(&mut self.bytes)]
    }

    /// Returns true when a complete synchronized frame ended in this input.
    fn scan(&mut self, data: &[u8]) -> bool {
        let mut closed = false;
        for &byte in data {
            if self.marker.is_empty() {
                if byte == 0x1b { self.marker.push(byte); }
                continue;
            }
            self.marker.push(byte);
            let is_begin_prefix = BEGIN.starts_with(&self.marker);
            let is_end_prefix = END.starts_with(&self.marker);
            if is_begin_prefix || is_end_prefix {
                if self.marker == BEGIN {
                    self.synchronized = true;
                    self.marker.clear();
                } else if self.marker == END {
                    self.synchronized = false;
                    self.marker.clear();
                    closed = true;
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
        let mut b = OutputBatcher::new(at(0));
        assert!(b.push(b"a", at(1)).is_empty());
        assert!(b.push(&vec![b'b'; TARGET_BYTES - 1], at(2)).len() == 1);
    }

    #[test]
    fn flushes_after_the_bounded_wait() {
        let mut b = OutputBatcher::new(at(0));
        assert!(b.push(b"a", at(3)).is_empty());
        assert_eq!(b.push(b"b", at(5)).concat(), b"ab");
    }

    #[test]
    fn keeps_a_split_dec_frame_in_one_batch() {
        let mut b = OutputBatcher::new(at(0));
        assert!(b.push(b"before\x1b[?2026hrow", at(10)).is_empty());
        assert!(b.push(b" two\x1b[?2026lafter", at(11)).len() == 1);
        assert_eq!(b.flush(at(12)).concat(), b"");
    }

    #[test]
    fn recognizes_markers_split_at_every_byte() {
        let mut b = OutputBatcher::new(at(0));
        let frame = b"\x1b[?2026hFULL\x1b[?2026l";
        let mut output = Vec::new();
        for byte in frame { output.extend(b.push(&[*byte], at(1))); }
        output.extend(b.flush(at(2)));
        assert_eq!(output.concat(), frame);
    }

    #[test]
    fn preserves_bytes_and_flushes_eof() {
        let mut b = OutputBatcher::new(at(0));
        assert!(b.push(b"one", at(1)).is_empty());
        assert_eq!(b.flush(at(2)).concat(), b"one");
        assert!(b.flush(at(3)).is_empty());
    }
}
