//! Capability-gated binary image chunks inside the existing length-prefixed stream.
//! Payload: NUL, big-endian JSON-header length, request JSON, raw image bytes.
pub const CAPABILITY: &str = "image.upload_v1";
pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_CHUNK_BYTES: usize = 64 * 1024;
pub const MAX_HEADER_BYTES: usize = 4096;

pub fn encode_chunk(header: &[u8], bytes: &[u8]) -> Result<Vec<u8>, &'static str> {
    if header.is_empty()
        || header.len() > MAX_HEADER_BYTES
        || bytes.is_empty()
        || bytes.len() > MAX_CHUNK_BYTES
    {
        return Err("invalid image chunk size");
    }
    let mut frame = Vec::with_capacity(5 + header.len() + bytes.len());
    frame.push(0);
    frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
    frame.extend_from_slice(header);
    frame.extend_from_slice(bytes);
    Ok(frame)
}

pub fn decode_chunk(frame: &[u8]) -> Result<(&[u8], &[u8]), &'static str> {
    if frame.len() < 5 || frame[0] != 0 {
        return Err("invalid image chunk frame");
    }
    let length = u32::from_be_bytes(frame[1..5].try_into().unwrap()) as usize;
    if length == 0
        || length > MAX_HEADER_BYTES
        || frame.len() <= 5 + length
        || frame.len() - 5 - length > MAX_CHUNK_BYTES
    {
        return Err("invalid image chunk size");
    }
    Ok((&frame[5..5 + length], &frame[5 + length..]))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_roundtrip_and_bounds() {
        let data = [0, 255, 10, 13, 0];
        let frame = encode_chunk(b"{}", &data).unwrap();
        assert_eq!(decode_chunk(&frame).unwrap(), (&b"{}"[..], &data[..]));
        for invalid in [
            vec![],
            vec![0, 255, 255, 255, 255],
            vec![0, 0, 0, 0, 2, b'{', b'}'],
        ] {
            assert!(decode_chunk(&invalid).is_err());
        }
        assert!(encode_chunk(b"{}", &vec![0; MAX_CHUNK_BYTES + 1]).is_err());
    }
}
