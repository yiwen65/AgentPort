//! Desktop-to-desktop pairing: redeem a controlled PC's one-time pairing
//! payload (the same Invitation JSON the phone QR flow encodes) into a local
//! `DeviceProfile`. The payload is a short-lived bearer credential — it is
//! parsed, validated and consumed, never logged or persisted.

use agentport_relay::crypto::Identity;
use agentport_relay::endpoint::PairingConnection;
use agentport_relay::protocol::{validate_name, Invitation};
use base64::Engine as _;

use crate::remote::relay::map_relay_error;
use crate::remote::types::{DeviceProfile, DeviceTransportProfile};
use crate::remote::RemoteCommandError;

/// Optional wrapper around the raw Invitation JSON for compact copy/paste.
pub const PAIRING_LINK_PREFIX: &str = "agentport-pair:";

/// Parses a pairing payload: raw Invitation JSON, or
/// `agentport-pair:<base64url(json)>`. Validation (shape, version, expiry,
/// peer key/host binding) is inherited from `Invitation::parse`.
pub fn parse_pairing_payload(payload: &str) -> Result<Invitation, RemoteCommandError> {
    let trimmed = payload.trim();
    let json = match trimmed.strip_prefix(PAIRING_LINK_PREFIX) {
        Some(encoded) => {
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(encoded.trim())
                .map_err(|_| {
                    RemoteCommandError::new(
                        "pairing_code_invalid",
                        "pairing link is not valid base64url",
                    )
                })?;
            String::from_utf8(bytes).map_err(|_| {
                RemoteCommandError::new("pairing_code_invalid", "pairing link is not UTF-8 JSON")
            })?
        }
        None => trimmed.to_string(),
    };
    Invitation::parse(&json)
        .map_err(|error| RemoteCommandError::new("pairing_code_invalid", error.to_string()))
}

/// Name this desktop presents to the controlled PC during pairing (recorded
/// in the PC's authorized device list). Hostname-suffixed when available.
fn controller_name() -> String {
    let mut buffer = [0_u8; 256];
    let raw = unsafe {
        if libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            String::from_utf8_lossy(&buffer[..end]).into_owned()
        } else {
            String::new()
        }
    };
    let sanitized: String = raw
        .chars()
        .filter(|character| !character.is_control())
        .take(60)
        .collect();
    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        "AgentPort Desktop".to_string()
    } else {
        format!("AgentPort {sanitized}")
    }
}

/// Redeems a pairing payload: Noise handshake as the invitation's holder and
/// waits for the controlled PC's (automatic) approval. `identity` must
/// already be persisted by the caller. `name` overrides the local display
/// name (default: the controlled PC's advertised name). The returned profile
/// is NOT persisted — the device registry (T-003) owns persistence.
pub async fn redeem_pairing(
    identity: &Identity,
    payload: &str,
    name: Option<String>,
) -> Result<DeviceProfile, RemoteCommandError> {
    let invitation = parse_pairing_payload(payload)?;
    let device_name = match name {
        Some(name) => {
            validate_name(&name).map_err(|error| {
                RemoteCommandError::new("device_name_invalid", error.to_string())
            })?;
            name
        }
        None => invitation.peer.name.clone(),
    };
    let pairing = PairingConnection::begin(identity, &invitation, controller_name())
        .await
        .map_err(map_relay_error)?;
    pairing.wait().await.map_err(|error| match error {
        agentport_relay::Error::Unauthorized => RemoteCommandError::new(
            "pairing_rejected",
            "pairing payload was already consumed or denied by the computer",
        ),
        agentport_relay::Error::Timeout => RemoteCommandError::new(
            "pairing_expired",
            "pairing payload expired before the computer approved it",
        ),
        other => map_relay_error(other),
    })?;
    let id = agentport_relay::protocol::identifier()
        .map_err(|error| RemoteCommandError::new("device_id_failed", error.to_string()))?;
    Ok(DeviceProfile {
        id: format!("dev_{id}"),
        name: device_name,
        transport: DeviceTransportProfile::Relay {
            peer: invitation.peer.clone(),
        },
        created_at: chrono::Utc::now().to_rfc3339(),
        last_connected_at: None,
        last_error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invitation_json() -> String {
        let host = Identity::generate().unwrap();
        let peer = host
            .peer(
                "ws://127.0.0.1:9/v1/relay".to_string(),
                "Fixture computer".to_string(),
            )
            .unwrap();
        serde_json::to_string(&Invitation::new(peer).unwrap()).unwrap()
    }

    #[test]
    fn parses_raw_invitation_json() {
        let invitation = parse_pairing_payload(&invitation_json()).unwrap();
        assert_eq!(invitation.peer.name, "Fixture computer");
    }

    #[test]
    fn parses_prefixed_base64url_link() {
        let json = invitation_json();
        let link = format!(
            "{PAIRING_LINK_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes())
        );
        let invitation = parse_pairing_payload(&link).unwrap();
        assert_eq!(invitation.peer.name, "Fixture computer");
    }

    #[test]
    fn rejects_expired_invitation() {
        let host = Identity::generate().unwrap();
        let peer = host
            .peer(
                "ws://127.0.0.1:9/v1/relay".to_string(),
                "Fixture computer".to_string(),
            )
            .unwrap();
        let mut value = serde_json::to_value(Invitation::new(peer).unwrap()).unwrap();
        value["expiresAt"] = serde_json::json!(1);
        let error = parse_pairing_payload(&serde_json::to_string(&value).unwrap())
            .err()
            .expect("must be rejected");
        assert_eq!(error.code, "pairing_code_invalid");
    }

    #[test]
    fn rejects_unknown_version() {
        let host = Identity::generate().unwrap();
        let peer = host
            .peer(
                "ws://127.0.0.1:9/v1/relay".to_string(),
                "Fixture computer".to_string(),
            )
            .unwrap();
        let mut value = serde_json::to_value(Invitation::new(peer).unwrap()).unwrap();
        value["version"] = serde_json::json!(99);
        let error = parse_pairing_payload(&serde_json::to_string(&value).unwrap())
            .err()
            .expect("must be rejected");
        assert_eq!(error.code, "pairing_code_invalid");
    }

    #[test]
    fn rejects_missing_fields_and_garbage() {
        for payload in [
            "{}",
            "not a pairing payload",
            "agentport-pair:!!!not-base64!!!",
            "agentport-pair:aGVsbG8", // "hello", not JSON
            "",
        ] {
            let error = parse_pairing_payload(payload)
                .err()
                .expect("must be rejected");
            assert_eq!(
                error.code, "pairing_code_invalid",
                "payload {payload:?} must be rejected as invalid"
            );
        }
    }

    #[test]
    fn controller_name_is_valid_and_bounded() {
        let name = controller_name();
        validate_name(&name).unwrap();
        assert!(name.starts_with("AgentPort"));
    }
}
