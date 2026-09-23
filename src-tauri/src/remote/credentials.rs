//! Device SSH secrets in the platform keychain.
//!
//! Passwords and private keys are stored ONLY in the OS keychain (service
//! `agentport-devices`, account `cred_<deviceId>`) as a small JSON document.
//! They never touch disk, logs, or any `DeviceProfile` serialization — the
//! profile carries only the account name (`auth_ref`). The store sits behind
//! a trait so registry/command flows are testable hermetically.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::remote::ssh::SshSecret;
use crate::remote::RemoteCommandError;

pub const KEYCHAIN_SERVICE: &str = "agentport-devices";

/// Keychain account holding one device's SSH secret. Mirrors the `auth_ref`
/// field persisted inside `DeviceTransportProfile::Ssh`.
pub fn credential_account(device_id: &str) -> String {
    format!("cred_{device_id}")
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum SecretDocument {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "privateKey")]
    PrivateKey {
        pem: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
}

fn encode_secret(secret: &SshSecret) -> Result<Zeroizing<String>, RemoteCommandError> {
    let document = match secret {
        SshSecret::Password(password) => SecretDocument::Password {
            password: password.as_str().to_string(),
        },
        SshSecret::PrivateKey { pem, passphrase } => SecretDocument::PrivateKey {
            pem: pem.as_str().to_string(),
            passphrase: passphrase.as_ref().map(|value| value.as_str().to_string()),
        },
    };
    serde_json::to_string(&document)
        .map(Zeroizing::new)
        .map_err(|error| RemoteCommandError::new("credential_encode_failed", error.to_string()))
}

fn decode_secret(payload: &[u8]) -> Result<SshSecret, RemoteCommandError> {
    let document: SecretDocument = serde_json::from_slice(payload).map_err(|error| {
        RemoteCommandError::new(
            "credential_decode_failed",
            format!("stored credential is unreadable: {error}"),
        )
    })?;
    Ok(match document {
        SecretDocument::Password { password } => SshSecret::Password(Zeroizing::new(password)),
        SecretDocument::PrivateKey { pem, passphrase } => SshSecret::PrivateKey {
            pem: Zeroizing::new(pem),
            passphrase: passphrase.map(Zeroizing::new),
        },
    })
}

/// Secret persistence for device credentials.
pub trait DeviceCredentialStore: Send + Sync {
    fn store(&self, device_id: &str, secret: &SshSecret) -> Result<(), RemoteCommandError>;
    fn load(&self, device_id: &str) -> Result<Option<SshSecret>, RemoteCommandError>;
    fn delete(&self, device_id: &str) -> Result<(), RemoteCommandError>;
}

/// Production store backed by the platform keychain (macOS Keychain /
/// Linux Secret Service via the `keyring` crate).
pub struct KeychainCredentialStore;

impl KeychainCredentialStore {
    fn entry(&self, device_id: &str) -> Result<keyring::Entry, RemoteCommandError> {
        keyring::Entry::new(KEYCHAIN_SERVICE, &credential_account(device_id))
            .map_err(|error| RemoteCommandError::new("credential_store_failed", error.to_string()))
    }
}

impl DeviceCredentialStore for KeychainCredentialStore {
    fn store(&self, device_id: &str, secret: &SshSecret) -> Result<(), RemoteCommandError> {
        let payload = encode_secret(secret)?;
        self.entry(device_id)?
            .set_secret(payload.as_str().as_bytes())
            .map_err(|error| RemoteCommandError::new("credential_store_failed", error.to_string()))
    }

    fn load(&self, device_id: &str) -> Result<Option<SshSecret>, RemoteCommandError> {
        let payload = match self.entry(device_id)?.get_secret() {
            Ok(payload) => payload,
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(error) => {
                return Err(RemoteCommandError::new(
                    "credential_load_failed",
                    error.to_string(),
                ))
            }
        };
        decode_secret(&payload).map(Some)
    }

    fn delete(&self, device_id: &str) -> Result<(), RemoteCommandError> {
        match self.entry(device_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(RemoteCommandError::new(
                "credential_delete_failed",
                error.to_string(),
            )),
        }
    }
}

/// Hermetic in-memory store for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryCredentialStore {
    inner: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

#[cfg(test)]
impl MemoryCredentialStore {
    pub fn has(&self, device_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .contains_key(&credential_account(device_id))
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().unwrap().is_empty()
    }
}

#[cfg(test)]
impl DeviceCredentialStore for MemoryCredentialStore {
    fn store(&self, device_id: &str, secret: &SshSecret) -> Result<(), RemoteCommandError> {
        let payload = encode_secret(secret)?;
        self.inner
            .lock()
            .unwrap()
            .insert(credential_account(device_id), payload.as_str().to_string());
        Ok(())
    }

    fn load(&self, device_id: &str) -> Result<Option<SshSecret>, RemoteCommandError> {
        let payload = self
            .inner
            .lock()
            .unwrap()
            .get(&credential_account(device_id))
            .cloned();
        payload
            .map(|payload| decode_secret(payload.as_bytes()))
            .transpose()
    }

    fn delete(&self, device_id: &str) -> Result<(), RemoteCommandError> {
        self.inner
            .lock()
            .unwrap()
            .remove(&credential_account(device_id));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_secret_round_trips_through_document() {
        let secret = SshSecret::Password(Zeroizing::new("s3cret".to_string()));
        let encoded = encode_secret(&secret).unwrap();
        assert!(encoded.as_str().contains("\"kind\":\"password\""));
        match decode_secret(encoded.as_str().as_bytes()).unwrap() {
            SshSecret::Password(password) => assert_eq!(password.as_str(), "s3cret"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn private_key_secret_round_trips_with_and_without_passphrase() {
        for passphrase in [None, Some("p@ss".to_string())] {
            let secret = SshSecret::PrivateKey {
                pem: Zeroizing::new("-----BEGIN-----\nabc\n-----END-----".to_string()),
                passphrase: passphrase.clone().map(Zeroizing::new),
            };
            let encoded = encode_secret(&secret).unwrap();
            match decode_secret(encoded.as_str().as_bytes()).unwrap() {
                SshSecret::PrivateKey {
                    pem,
                    passphrase: restored,
                } => {
                    assert!(pem.as_str().contains("BEGIN"));
                    assert_eq!(
                        restored.as_ref().map(|value| value.as_str().to_string()),
                        passphrase
                    );
                }
                _ => panic!("wrong variant"),
            }
        }
    }

    #[test]
    fn corrupt_document_is_a_structured_error() {
        let error = decode_secret(b"not-json{{").unwrap_err();
        assert_eq!(error.code, "credential_decode_failed");
    }

    #[test]
    fn memory_store_round_trip_and_delete() {
        let store = MemoryCredentialStore::default();
        assert!(store.load("dev_1").unwrap().is_none());
        let secret = SshSecret::Password(Zeroizing::new("pw".to_string()));
        store.store("dev_1", &secret).unwrap();
        assert!(store.has("dev_1"));
        match store.load("dev_1").unwrap() {
            Some(SshSecret::Password(password)) => assert_eq!(password.as_str(), "pw"),
            _ => panic!("wrong secret"),
        }
        store.delete("dev_1").unwrap();
        assert!(!store.has("dev_1"));
        assert!(store.load("dev_1").unwrap().is_none());
        // Deleting a missing credential is idempotent.
        store.delete("dev_1").unwrap();
    }
}
