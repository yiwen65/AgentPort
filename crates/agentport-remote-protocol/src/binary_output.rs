//! Capability-gated binary terminal output frames. The outer stream keeps the
//! existing u32 length prefix; a payload starting with NUL carries a JSON event
//! envelope and raw PTY bytes instead of embedding base64 in JSON.
use crate::{Event, ProtocolError, ServerEnvelope};
use base64::Engine as _;
use serde_json::Value;
use std::io::Write;

pub const CAPABILITY: &str = "terminal.output_binary_v1";
pub const MAX_HEADER_BYTES: usize = 4096;
const TAG: u8 = 0;

pub fn encode_envelope(envelope: &ServerEnvelope) -> Result<Option<Vec<u8>>, ProtocolError> {
    let ServerEnvelope::Event(event) = envelope else {
        return Ok(None);
    };
    if !matches!(event.event_type.as_str(), "output" | "transient_output") {
        return Ok(None);
    }
    let Some(data) = event.payload.get("dataBase64").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else {
        return Ok(None);
    };
    let mut payload = event.payload.clone();
    let Some(payload) = payload.as_object_mut() else {
        return Ok(None);
    };
    payload.remove("dataBase64");
    let header = serde_json::to_vec(&ServerEnvelope::Event(Event {
        subscription_id: event.subscription_id.clone(),
        event_type: event.event_type.clone(),
        cursor: event.cursor.clone(),
        payload: Value::Object(payload.clone()),
    }))?;
    if header.len() > MAX_HEADER_BYTES {
        return Ok(None);
    }
    let mut frame = Vec::with_capacity(5 + header.len() + bytes.len());
    frame.push(TAG);
    frame.extend_from_slice(&(header.len() as u32).to_be_bytes());
    frame.extend_from_slice(&header);
    frame.extend_from_slice(&bytes);
    Ok(Some(frame))
}

/// Write an already-framed binary payload with the protocol's u32 prefix.
pub fn write_frame<W: Write>(
    writer: &mut W,
    payload: &[u8],
    maximum: u32,
) -> Result<(), ProtocolError> {
    write_frame_unflushed(writer, payload, maximum)?;
    writer.flush()?;
    Ok(())
}

pub fn write_frame_unflushed<W: Write>(
    writer: &mut W,
    payload: &[u8],
    maximum: u32,
) -> Result<(), ProtocolError> {
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::LengthOverflow)?;
    if length > maximum {
        return Err(ProtocolError::FrameTooLarge {
            actual: length,
            maximum,
        });
    }
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(payload)?;
    Ok(())
}

pub fn decode_envelope(frame: &[u8]) -> Result<Option<ServerEnvelope>, ProtocolError> {
    if frame.first() != Some(&TAG) {
        return Ok(None);
    }
    if frame.len() < 5 {
        return Err(ProtocolError::UnexpectedEof);
    }
    let header_len = u32::from_be_bytes(frame[1..5].try_into().unwrap()) as usize;
    if header_len == 0 || header_len > MAX_HEADER_BYTES || frame.len() < 5 + header_len {
        return Err(ProtocolError::UnexpectedEof);
    }
    let mut envelope: Value = serde_json::from_slice(&frame[5..5 + header_len])?;
    let data = &frame[5 + header_len..];
    let Some(payload) = envelope.get_mut("payload").and_then(Value::as_object_mut) else {
        return Err(ProtocolError::UnexpectedEof);
    };
    payload.insert(
        "dataBase64".into(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(data)),
    );
    Ok(Some(serde_json::from_value(envelope)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Event, RunCursor};

    fn cursor() -> RunCursor {
        RunCursor {
            run_id: "run".into(),
            run_ordinal: 1,
            generation: 0,
            offset: 0,
            status_sequence: 0,
        }
    }

    #[test]
    fn binary_output_roundtrip_preserves_metadata_and_bytes() {
        let bytes = [0, 255, 10, 13, b'h', b'i'];
        let envelope = ServerEnvelope::Event(Event {
            subscription_id: "att-1".into(),
            event_type: "output".into(),
            cursor: cursor(),
            payload: serde_json::json!({
                "sessionId": "ses-1",
                "dataBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
        });
        let frame = encode_envelope(&envelope).unwrap().unwrap();
        let decoded = decode_envelope(&frame).unwrap().unwrap();
        let ServerEnvelope::Event(event) = decoded else {
            panic!("expected event");
        };
        assert_eq!(event.subscription_id, "att-1");
        assert_eq!(event.payload["sessionId"], "ses-1");
        let decoded_bytes = base64::engine::general_purpose::STANDARD
            .decode(event.payload["dataBase64"].as_str().unwrap())
            .unwrap();
        assert_eq!(decoded_bytes, bytes);
    }

    #[test]
    fn non_output_or_missing_data_falls_back_to_json() {
        let event = ServerEnvelope::Event(Event {
            subscription_id: "att-1".into(),
            event_type: "state".into(),
            cursor: cursor(),
            payload: serde_json::json!({}),
        });
        assert!(encode_envelope(&event).unwrap().is_none());
        let output = ServerEnvelope::Event(Event {
            subscription_id: "att-1".into(),
            event_type: "output".into(),
            cursor: cursor(),
            payload: serde_json::json!({"sessionId": "ses-1"}),
        });
        assert!(encode_envelope(&output).unwrap().is_none());
    }

    #[test]
    fn decode_rejects_malformed_binary_frames() {
        assert!(decode_envelope(b"{}").unwrap().is_none());
        assert!(decode_envelope(&[0, 0, 0, 0, 0]).is_err());
        assert!(decode_envelope(&[0, 0, 0, 0, 2, b'{']).is_err());
    }
}
