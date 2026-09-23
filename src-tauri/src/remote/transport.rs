//! Blocking framed transport primitives for the remote client.
//!
//! Wire format (agentport-remote-protocol): 4-byte big-endian length prefix
//! followed by one JSON payload, bounded by `MAX_FRAME_BYTES`. The protocol
//! crate exposes `read_frame`/`write_frame` over `std::io`; these traits keep
//! every blocking read/write off the Tauri async runtime (dedicated threads
//! in `connection`/`ssh`).

use std::io::{Read, Write};

use agentport_remote_protocol::{read_frame, ProtocolError, MAX_FRAME_BYTES};

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame error: {0}")]
    Frame(#[from] ProtocolError),
    #[error("transport is closed")]
    Closed,
    #[error("timed out waiting for the peer")]
    Timeout,
}

impl TransportError {
    /// Stable machine-readable code surfaced to the frontend.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "transport_io",
            Self::Frame(ProtocolError::FrameTooLarge { .. }) => "frame_too_large",
            Self::Frame(_) => "frame_corrupt",
            Self::Closed => "transport_closed",
            Self::Timeout => "transport_timeout",
        }
    }
}

/// One half of a framed connection. `Ok(None)` signals a clean peer EOF.
///
/// Note: no timeout API by design — macOS rejects clearing SO_RCVTIMEO back
/// to None (EINVAL), so deadlines live in the connection's dispatch channels
/// instead of on the socket.
pub trait FrameReader: Send {
    fn read_frame(&mut self) -> Result<Option<Vec<u8>>, TransportError>;
}

pub trait FrameWriter: Send {
    /// `payload` is an already-serialized JSON document written as one frame.
    fn write_frame(&mut self, payload: &[u8]) -> Result<(), TransportError>;
    /// Best-effort half-close. The writer must not be used afterwards.
    fn shutdown(&mut self);
}

/// Serializes `payload` into one length-prefixed frame (protocol-compatible).
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, TransportError> {
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::LengthOverflow)?;
    if length > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            actual: length,
            maximum: MAX_FRAME_BYTES,
        }
        .into());
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(payload);
    Ok(frame)
}

/// Frame reader over any blocking `Read` (process pipes, sockets in tests).
#[allow(dead_code)] // T-002's relay transport reuses this; tests use it now
pub struct IoFrameReader<R: Read + Send> {
    reader: R,
}

#[allow(dead_code)] // T-002's relay transport reuses this; tests use it now
impl<R: Read + Send> IoFrameReader<R> {
    pub fn new(reader: R) -> Self {
        Self { reader }
    }
}

impl<R: Read + Send> FrameReader for IoFrameReader<R> {
    fn read_frame(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        match read_frame(&mut self.reader, MAX_FRAME_BYTES)? {
            Some(buffer) => Ok(Some(buffer.as_bytes().to_vec())),
            None => Ok(None),
        }
    }
}

/// Frame reader over a Unix socket.
#[cfg(unix)]
#[allow(dead_code)] // used by tests today; real socket transports later
pub struct SocketFrameReader {
    stream: std::os::unix::net::UnixStream,
}

#[cfg(unix)]
#[allow(dead_code)] // used by tests today; real socket transports later
impl SocketFrameReader {
    pub fn new(stream: std::os::unix::net::UnixStream) -> Self {
        Self { stream }
    }
}

#[cfg(unix)]
impl FrameReader for SocketFrameReader {
    fn read_frame(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        match read_frame(&mut self.stream, MAX_FRAME_BYTES)? {
            Some(buffer) => Ok(Some(buffer.as_bytes().to_vec())),
            None => Ok(None),
        }
    }
}

/// Frame writer over any blocking `Write` (e.g. a child's stdin pipe).
/// `shutdown` drops the underlying writer so the peer observes EOF.
#[allow(dead_code)] // T-002's relay transport reuses this; tests use it now
pub struct IoFrameWriter<W: Write + Send> {
    writer: Option<W>,
}

#[allow(dead_code)] // T-002's relay transport reuses this; tests use it now
impl<W: Write + Send> IoFrameWriter<W> {
    pub fn new(writer: W) -> Self {
        Self {
            writer: Some(writer),
        }
    }
}

impl<W: Write + Send> FrameWriter for IoFrameWriter<W> {
    fn write_frame(&mut self, payload: &[u8]) -> Result<(), TransportError> {
        let writer = self.writer.as_mut().ok_or(TransportError::Closed)?;
        let frame = encode_frame(payload)?;
        writer.write_all(&frame)?;
        writer.flush()?;
        Ok(())
    }

    fn shutdown(&mut self) {
        // Dropping the last handle closes the pipe: the peer sees EOF.
        let _ = self.writer.take();
    }
}

/// Frame writer over a Unix socket. `shutdown` closes BOTH directions so a
/// reader blocked on another handle of the same socket wakes up with EOF —
/// a flush-only shutdown would deadlock the connection's reader thread.
#[cfg(unix)]
#[allow(dead_code)] // used by tests today; real socket transports later
pub struct UnixStreamFrameWriter {
    stream: std::os::unix::net::UnixStream,
}

#[cfg(unix)]
#[allow(dead_code)] // used by tests today; real socket transports later
impl UnixStreamFrameWriter {
    pub fn new(stream: std::os::unix::net::UnixStream) -> Self {
        Self { stream }
    }
}

#[cfg(unix)]
impl FrameWriter for UnixStreamFrameWriter {
    fn write_frame(&mut self, payload: &[u8]) -> Result<(), TransportError> {
        let frame = encode_frame(payload)?;
        self.stream.write_all(&frame)?;
        self.stream.flush()?;
        Ok(())
    }

    fn shutdown(&mut self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_frame_prefixes_big_endian_length() {
        let frame = encode_frame(b"{}").unwrap();
        assert_eq!(frame, vec![0, 0, 0, 2, b'{', b'}']);
    }

    #[test]
    fn encode_frame_rejects_oversize() {
        let payload = vec![0_u8; (MAX_FRAME_BYTES + 1) as usize];
        assert!(matches!(
            encode_frame(&payload),
            Err(TransportError::Frame(ProtocolError::FrameTooLarge { .. }))
        ));
    }

    #[test]
    fn corrupt_length_prefix_is_rejected() {
        let mut raw: &[u8] = &(MAX_FRAME_BYTES + 1).to_be_bytes();
        let mut reader = IoFrameReader::new(&mut raw);
        assert!(matches!(
            reader.read_frame(),
            Err(TransportError::Frame(ProtocolError::FrameTooLarge { .. }))
        ));
    }

    #[test]
    fn truncated_payload_is_an_error_not_a_partial_frame() {
        let mut raw = 5_u32.to_be_bytes().to_vec();
        raw.extend_from_slice(b"ab");
        let mut reader = IoFrameReader::new(raw.as_slice());
        assert!(matches!(
            reader.read_frame(),
            Err(TransportError::Frame(ProtocolError::UnexpectedEof))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn round_trip_over_unix_socket_pair() {
        let (left, right) = std::os::unix::net::UnixStream::pair().unwrap();
        let mut reader = SocketFrameReader::new(left);
        let mut writer = IoFrameWriter::new(right);
        writer.write_frame(br#"{"ok":true}"#).unwrap();
        let frame = reader.read_frame().unwrap().expect("one frame");
        assert_eq!(frame, br#"{"ok":true}"#);
        drop(writer);
        assert!(matches!(reader.read_frame(), Ok(None)), "expected EOF");
    }
}
