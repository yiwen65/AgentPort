//! Personal-use APNs provider for generic, visible session alerts.
//! The caller must obtain the `.p8` key securely and supply only opaque host/session IDs;
//! this module never persists the key, token, JWT, or notification contents.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{
    rand::SystemRandom,
    signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
};
use serde::Serialize;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

const JWT_LIFETIME: u64 = 45 * 60; // APNs rejects provider tokens older than one hour.
const MAX_RESPONSE_BYTES: usize = 4096;

/// Selects the APNs endpoint corresponding to the app's entitlement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Sandbox,
    Production,
}

impl Environment {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Sandbox => "https://api.sandbox.push.apple.com/3/device/",
            Self::Production => "https://api.push.apple.com/3/device/",
        }
    }
}

/// Only these fixed, content-free alert categories may be sent to APNs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    ApprovalRequested,
    TurnCompleted,
    ExecutionFailed,
}

impl AttentionKind {
    fn body(self) -> &'static str {
        match self {
            Self::ApprovalRequested => "An AgentPort session requests your approval.",
            Self::TurnCompleted => "An AgentPort session finished a turn.",
            Self::ExecutionFailed => "An AgentPort session encountered an error.",
        }
    }
}

/// Categorized error. Debug/Display output never includes credentials or device tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum PushError {
    #[error("invalid APNs provider configuration or private key")]
    InvalidConfig,
    #[error("invalid APNs device token")]
    InvalidToken,
    #[error("invalid opaque notification identifier")]
    InvalidIdentifier,
    #[error("temporary APNs failure (HTTP status: {status:?})")]
    Transient { status: Option<u16> },
    #[error("APNs permanently rejected this request (HTTP status: {status})")]
    Permanent { status: u16 },
    #[error("APNs device token is unregistered")]
    Revoked,
}

struct CachedJwt {
    value: Zeroizing<String>,
    issued_at: u64,
}

/// Reusable HTTP/2 APNs client. Share one instance across sends to reuse TLS and JWTs.
/// No automatic retry: callers should back off on `Transient` and remove tokens on `Revoked`.
/// `key_p8_pem` must be the unencrypted Apple ES256 PKCS#8 PEM; the caller owns its
/// input buffer and is responsible for protecting/clearing it after construction.
pub struct ApnsSender {
    client: reqwest::Client,
    signing_key: EcdsaKeyPair,
    key_id: String,
    team_id: String,
    topic: String,
    environment: Environment,
    jwt: Mutex<Option<CachedJwt>>,
}

impl ApnsSender {
    /// Validates identifiers and parses the private key without making a network request.
    /// Key ID and Team ID are Apple's ten-character identifiers; topic is the app bundle ID.
    pub fn new(
        key_p8_pem: &[u8],
        key_id: &str,
        team_id: &str,
        topic: &str,
        environment: Environment,
    ) -> Result<Self, PushError> {
        if !apple_id(key_id)
            || !apple_id(team_id)
            || !bundle_topic(topic)
            || key_p8_pem.len() > 16 * 1024
        {
            return Err(PushError::InvalidConfig);
        }
        let pem = std::str::from_utf8(key_p8_pem).map_err(|_| PushError::InvalidConfig)?;
        let pem = pem.trim();
        let body = pem
            .strip_prefix("-----BEGIN PRIVATE KEY-----")
            .and_then(|s| s.strip_suffix("-----END PRIVATE KEY-----"))
            .ok_or(PushError::InvalidConfig)?;
        if !body.chars().all(|c| {
            c.is_ascii_whitespace() || c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '='
        }) {
            return Err(PushError::InvalidConfig);
        }
        let encoded = Zeroizing::new(
            body.chars()
                .filter(|c| !c.is_ascii_whitespace())
                .collect::<String>(),
        );
        let der = Zeroizing::new(
            base64::engine::general_purpose::STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| PushError::InvalidConfig)?,
        );
        let rng = SystemRandom::new();
        let signing_key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &rng)
            .map_err(|_| PushError::InvalidConfig)?;
        let client = reqwest::Client::builder()
            .https_only(true)
            .http2_prior_knowledge()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| PushError::InvalidConfig)?;
        Ok(Self {
            client,
            signing_key,
            key_id: key_id.to_owned(),
            team_id: team_id.to_owned(),
            topic: topic.to_owned(),
            environment,
            jwt: Mutex::new(None),
        })
    }

    /// Sends one fixed, content-free visible alert for `kind`. `device_token` is
    /// APNs' hex token; `host_id` and `session_id` must be opaque ASCII identifiers,
    /// NEVER terminal output,
    /// a command, path, user input, or other human-readable/private content.
    pub async fn send_alert(
        &self,
        device_token: &str,
        kind: AttentionKind,
        host_id: &str,
        session_id: &str,
    ) -> Result<(), PushError> {
        if !valid_device_token(device_token) {
            return Err(PushError::InvalidToken);
        }
        if !opaque_id(host_id) || !opaque_id(session_id) {
            return Err(PushError::InvalidIdentifier);
        }
        let jwt = self.provider_token().await?;
        let payload = serde_json::to_vec(&alert_payload(kind, host_id, session_id))
            .map_err(|_| PushError::InvalidConfig)?;
        let url = format!("{}{device_token}", self.environment.endpoint());
        let mut response = self
            .client
            .post(url)
            .header("authorization", format!("bearer {}", jwt.as_str()))
            .header("apns-push-type", "alert")
            .header("apns-topic", &self.topic)
            .header("apns-priority", "10")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
            .await
            .map_err(|_| PushError::Transient { status: None })?;
        let status = response.status().as_u16();
        if response.version() != reqwest::Version::HTTP_2 {
            return Err(PushError::Transient {
                status: Some(status),
            });
        }
        if response.status().is_success() {
            return Ok(());
        }
        let mut data = Vec::new();
        while data.len() < MAX_RESPONSE_BYTES {
            match response.chunk().await {
                Ok(Some(chunk)) => data
                    .extend_from_slice(&chunk[..chunk.len().min(MAX_RESPONSE_BYTES - data.len())]),
                Ok(None) => break,
                Err(_) => {
                    return Err(PushError::Transient {
                        status: Some(status),
                    })
                }
            }
        }
        let reason = serde_json::from_slice::<ApnsResponse>(&data)
            .ok()
            .map(|r| r.reason);
        let expired = reason.as_deref() == Some("ExpiredProviderToken");
        if expired {
            // A clock jump or server-side expiry must not keep reusing a stale JWT.
            let mut cache = self.jwt.lock().await;
            if cache
                .as_ref()
                .is_some_and(|cached| cached.value.as_str() == jwt.as_str())
            {
                cache.take();
            }
        }
        Err(classify_response(status, reason.as_deref()))
    }

    async fn provider_token(&self) -> Result<Zeroizing<String>, PushError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| PushError::Transient { status: None })?
            .as_secs();
        let mut cache = self.jwt.lock().await;
        if let Some(cached) = cache.as_ref() {
            if now >= cached.issued_at && now - cached.issued_at < JWT_LIFETIME {
                return Ok(cached.value.clone());
            }
        }
        let header = serde_json::json!({"alg": "ES256", "kid": self.key_id, "typ": "JWT"});
        let claims = serde_json::json!({"iss": self.team_id, "iat": now});
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&header).map_err(|_| PushError::InvalidConfig)?),
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&claims).map_err(|_| PushError::InvalidConfig)?),
        );
        let signature = self
            .signing_key
            .sign(&SystemRandom::new(), input.as_bytes())
            .map_err(|_| PushError::Transient { status: None })?;
        let value = Zeroizing::new(format!(
            "{}.{}",
            input,
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ));
        *cache = Some(CachedJwt {
            value: value.clone(),
            issued_at: now,
        });
        Ok(value)
    }
}

fn apple_id(value: &str) -> bool {
    value.len() == 10
        && value
            .bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
}

fn bundle_topic(value: &str) -> bool {
    (3..=255).contains(&value.len())
        && value.contains('.')
        && value.split('.').all(|part| {
            !part.is_empty() && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

/// APNs token length may change; do not assume a fixed 32-byte binary token.
fn valid_device_token(token: &str) -> bool {
    (2..=512).contains(&token.len())
        && token.len() % 2 == 0
        && token.bytes().all(|c| c.is_ascii_hexdigit())
}

fn opaque_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn alert_payload<'a>(
    kind: AttentionKind,
    host_id: &'a str,
    session_id: &'a str,
) -> AlertPayload<'a> {
    AlertPayload {
        aps: Aps {
            alert: Alert {
                title: "AgentPort",
                body: kind.body(),
            },
            sound: "default",
        },
        kind,
        host_id,
        session_id,
    }
}

#[derive(Serialize)]
struct AlertPayload<'a> {
    aps: Aps,
    kind: AttentionKind,
    #[serde(rename = "hostId")]
    host_id: &'a str,
    #[serde(rename = "sessionId")]
    session_id: &'a str,
}
#[derive(Serialize)]
struct Aps {
    alert: Alert,
    sound: &'static str,
}
#[derive(Serialize)]
struct Alert {
    title: &'static str,
    body: &'static str,
}
#[derive(serde::Deserialize)]
struct ApnsResponse {
    reason: String,
}

fn classify_response(status: u16, reason: Option<&str>) -> PushError {
    if status == 410 {
        PushError::Revoked
    } else if status == 400 && reason == Some("BadDeviceToken") {
        PushError::InvalidToken
    } else if status == 408
        || status == 429
        || status >= 500
        || matches!(
            reason,
            Some("ExpiredProviderToken" | "TooManyRequests" | "TooManyProviderTokenUpdates")
        )
    {
        PushError::Transient {
            status: Some(status),
        }
    } else {
        PushError::Permanent { status }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};

    fn sender() -> ApnsSender {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----",
            base64::engine::general_purpose::STANDARD.encode(pkcs8.as_ref())
        );
        ApnsSender::new(
            pem.as_bytes(),
            "ABCDEFGHI1",
            "TEAMABCDE1",
            "com.example.agentport",
            Environment::Sandbox,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn jwt_headers_claims_signature_and_cache() {
        let sender = sender();
        let jwt = sender.provider_token().await.unwrap();
        assert_eq!(
            jwt.as_str(),
            sender.provider_token().await.unwrap().as_str()
        );
        let segments: Vec<_> = jwt.split('.').collect();
        assert_eq!(segments.len(), 3);
        let header: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[0]).unwrap()).unwrap();
        let claims: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(segments[1]).unwrap()).unwrap();
        assert_eq!(
            header,
            serde_json::json!({"alg":"ES256","kid":"ABCDEFGHI1","typ":"JWT"})
        );
        assert_eq!(claims["iss"], "TEAMABCDE1");
        assert!(claims["iat"].as_u64().unwrap() > 1_000_000_000);
        let public_key = sender.signing_key.public_key();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, public_key.as_ref())
            .verify(
                format!("{}.{}", segments[0], segments[1]).as_bytes(),
                &URL_SAFE_NO_PAD.decode(segments[2]).unwrap(),
            )
            .unwrap();
    }

    #[test]
    fn three_kinds_have_distinct_safe_payloads() {
        for (kind, wire_kind, body) in [
            (
                AttentionKind::ApprovalRequested,
                "approval_requested",
                "An AgentPort session requests your approval.",
            ),
            (
                AttentionKind::TurnCompleted,
                "turn_completed",
                "An AgentPort session finished a turn.",
            ),
            (
                AttentionKind::ExecutionFailed,
                "execution_failed",
                "An AgentPort session encountered an error.",
            ),
        ] {
            let payload =
                serde_json::to_value(alert_payload(kind, "0123456789abcdef", "fedcba9876543210"))
                    .unwrap();
            assert_eq!(
                payload,
                serde_json::json!({
                    "aps": {"alert": {"title":"AgentPort", "body":body}, "sound":"default"},
                    "kind":wire_kind, "hostId":"0123456789abcdef", "sessionId":"fedcba9876543210"
                })
            );
        }
    }

    #[test]
    fn rejects_invalid_key_and_tokens_without_echoing_them() {
        assert!(matches!(
            ApnsSender::new(
                b"not a PEM",
                "ABCDEFGHI1",
                "TEAMABCDE1",
                "com.example.app",
                Environment::Production
            ),
            Err(PushError::InvalidConfig)
        ));
        assert!(matches!(
            ApnsSender::new(
                b"-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
                "ABCDEFGHI1",
                "TEAMABCDE1",
                "com.example.app",
                Environment::Production
            ),
            Err(PushError::InvalidConfig)
        ));
        assert!(!valid_device_token("bad/token"));
        assert!(!valid_device_token("0"));
        assert!(valid_device_token(&"ab".repeat(32)));
        assert!(!opaque_id("terminal body here"));
        assert!(!bundle_topic("com.example.app\r\napns-topic:evil"));
    }

    #[tokio::test]
    async fn rejects_bad_token_before_network() {
        let err = sender()
            .send_alert(
                "secret/bad-token",
                AttentionKind::ApprovalRequested,
                "0123456789abcdef",
                "fedcba9876543210",
            )
            .await
            .unwrap_err();
        assert_eq!(err, PushError::InvalidToken);
        assert!(!format!("{err:?}").contains("secret/bad-token"));
    }

    #[test]
    fn classifies_apns_responses() {
        assert_eq!(
            classify_response(410, Some("Unregistered")),
            PushError::Revoked
        );
        assert_eq!(
            classify_response(400, Some("BadDeviceToken")),
            PushError::InvalidToken
        );
        // A misconfigured topic is provider-wide; correcting it and restarting
        // must not leave this device durably disabled.
        assert_eq!(
            classify_response(400, Some("DeviceTokenNotForTopic")),
            PushError::Permanent { status: 400 }
        );
        assert_eq!(
            classify_response(403, Some("InvalidProviderToken")),
            PushError::Permanent { status: 403 }
        );
        assert_eq!(
            classify_response(403, Some("ExpiredProviderToken")),
            PushError::Transient { status: Some(403) }
        );
        assert_eq!(
            classify_response(429, None),
            PushError::Transient { status: Some(429) }
        );
        assert_eq!(
            classify_response(503, None),
            PushError::Transient { status: Some(503) }
        );
    }
}
