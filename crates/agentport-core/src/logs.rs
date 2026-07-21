//! Append-only per-session output logs with size-capped rotation (PRD 3.3, 7.4,
//! ch.10 log-limit metric).
//!
//! Policy: one `output.log` per session. When appending would exceed the limit,
//! the file is deleted and a fresh one started — "最近 N MiB 保留" (7.4).
//! Rotation never blocks a write mid-chunk: a chunk is always written atomically
//! as one `write_all`, so byte order within a generation is exactly the PTY
//! stream order (ch.10 日志一致性 SHA-256).

use crate::error::Result;
use crate::redact::Redactor;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WriteReceipt {
    /// Offset within the CURRENT generation where the chunk starts.
    pub offset: u64,
    pub len: u64,
    /// True when this write started a new generation (old content dropped).
    pub rotated: bool,
    /// Monotonic generation counter (0 = first file).
    pub generation: u64,
}

pub struct LogWriter {
    path: PathBuf,
    file: File,
    limit_bytes: u64,
    len: u64,
    generation: u64,
    redactor: Option<Redactor>,
    /// Total bytes ever appended (across generations) — for offset reporting.
    total_appended: u64,
    pub redaction_hits: u64,
}

impl LogWriter {
    pub fn open(path: &Path, limit_bytes: u64, redactor: Option<Redactor>) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Restrictive permissions — logs may contain sensitive source output.
        let mut opts = OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let file = opts.open(path)?;
        let len = file.metadata()?.len();
        Ok(LogWriter {
            path: path.to_path_buf(),
            file,
            limit_bytes,
            len,
            generation: 0,
            redactor,
            total_appended: len,
            redaction_hits: 0,
        })
    }

    pub fn limit_bytes(&self) -> u64 {
        self.limit_bytes
    }
    /// Bytes in the current generation on disk.
    pub fn current_len(&self) -> u64 {
        self.len
    }
    /// Bytes ever appended (monotonic, used as the global output offset).
    pub fn total_appended(&self) -> u64 {
        self.total_appended
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// Append one chunk. Never fails silently; errors propagate and the caller
    /// (host) records them — output must not be lost without a trace.
    pub fn append(&mut self, chunk: &[u8]) -> Result<WriteReceipt> {
        let data = match &mut self.redactor {
            Some(r) => {
                let out = r.feed(chunk);
                self.redaction_hits = r.hits();
                out
            }
            None => chunk.to_vec(),
        };
        if data.is_empty() {
            return Ok(WriteReceipt {
                offset: self.len,
                len: 0,
                rotated: false,
                generation: self.generation,
            });
        }
        let mut rotated = false;
        if self.len + data.len() as u64 > self.limit_bytes && self.len > 0 {
            self.rotate()?;
            rotated = true;
        }
        let offset = self.len;
        self.file.write_all(&data)?;
        self.file.flush()?;
        self.len += data.len() as u64;
        self.total_appended += chunk.len() as u64; // raw stream bytes, pre-redaction
        Ok(WriteReceipt {
            offset,
            len: data.len() as u64,
            rotated,
            generation: self.generation,
        })
    }

    /// Flush the redactor's withheld tail (on shutdown).
    pub fn finish(&mut self) -> Result<()> {
        if let Some(r) = &mut self.redactor {
            let tail = r.finish();
            self.redaction_hits = r.hits();
            if !tail.is_empty() {
                if self.len + tail.len() as u64 > self.limit_bytes && self.len > 0 {
                    self.rotate()?;
                }
                self.file.write_all(&tail)?;
                self.file.flush()?;
                self.len += tail.len() as u64;
            }
        }
        Ok(())
    }

    fn rotate(&mut self) -> Result<()> {
        // Drop the current generation entirely and start fresh (PRD 7.4:
        // only the most recent window is kept). The search index marks hits
        // into dropped generations as "输出已轮转".
        self.file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&self.path)?;
        self.len = 0;
        self.generation += 1;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Reading / verification
// ---------------------------------------------------------------------------

/// Read the last `n` bytes of the log (current generation).
pub fn tail_bytes(path: &Path, n: u64) -> Result<Vec<u8>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let start = len.saturating_sub(n);
    f.seek(SeekFrom::Start(start))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

/// Read a range from the current generation; returns empty when the range fell
/// into a rotated-away window (caller marks "输出已轮转", never errors — PRD 3.6).
pub fn read_range(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>> {
    let mut f = File::open(path)?;
    let flen = f.metadata()?.len();
    if offset >= flen {
        return Ok(Vec::new());
    }
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::new();
    f.take(len.min(flen - offset)).read_to_end(&mut buf)?;
    Ok(buf)
}

/// SHA-256 hex digest of a file — used by log-consistency tests (ch.10).
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut f = File::open(path)?;
    let mut h = Sha256::new();
    std::io::copy(&mut f, &mut h)?;
    Ok(format!("{:x}", h.finalize()))
}

pub fn sha256_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::Redactor;

    #[test]
    fn byte_order_and_sha256_match_stream() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.log");
        let mut w = LogWriter::open(&p, 1 << 20, None).unwrap();
        let mut stream = Vec::new();
        for i in 0..1000u32 {
            let chunk = format!("line {i}\n").into_bytes();
            stream.extend_from_slice(&chunk);
            w.append(&chunk).unwrap();
        }
        w.finish().unwrap();
        drop(w);
        assert_eq!(std::fs::read(&p).unwrap(), stream);
        assert_eq!(sha256_file(&p).unwrap(), sha256_bytes(&stream));
    }

    #[test]
    fn rotation_keeps_disk_under_limit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.log");
        let limit = 64 * 1024u64;
        let mut w = LogWriter::open(&p, limit, None).unwrap();
        let chunk = vec![b'x'; 8192];
        let mut rotated = false;
        for _ in 0..40 {
            // 320 KiB total → several rotations
            if w.append(&chunk).unwrap().rotated {
                rotated = true;
            }
            assert!(w.current_len() <= limit);
            assert!(std::fs::metadata(&p).unwrap().len() <= limit);
        }
        w.finish().unwrap();
        assert!(rotated);
        assert!(std::fs::metadata(&p).unwrap().len() <= limit);
    }

    #[test]
    fn redacting_writer_masks_and_counts() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.log");
        let r = Redactor::new(vec![b"supersecretvalue".to_vec()]);
        let mut w = LogWriter::open(&p, 1 << 20, Some(r)).unwrap();
        w.append(b"token=supersecretvalue ok").unwrap();
        w.append(b"boundary super").unwrap();
        w.append(b"secretvalue done").unwrap();
        w.finish().unwrap();
        let on_disk = std::fs::read_to_string(&p).unwrap();
        assert!(!on_disk.contains("supersecretvalue"));
        assert!(w.redaction_hits >= 2);
    }

    #[test]
    fn tail_and_range_reads() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.log");
        std::fs::write(&p, b"0123456789").unwrap();
        assert_eq!(tail_bytes(&p, 4).unwrap(), b"6789");
        assert_eq!(read_range(&p, 2, 3).unwrap(), b"234");
        assert_eq!(read_range(&p, 50, 3).unwrap(), b"");
    }
}
