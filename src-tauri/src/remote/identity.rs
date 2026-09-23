//! The desktop CLIENT's relay identity.
//!
//! One long-lived Noise identity per desktop installation, independent of any
//! connector namespace: the connector proves THIS machine is the controlled
//! side; this identity proves THIS machine is a controlling client. Persisted
//! at `<data-root>/devices/identity.json` (0600 file, 0700 dir) following the
//! pairing endpoint's custody rule — the identity must already be durable
//! before `PairingConnection::begin`, or an interrupted approval could leave
//! an authorized key this client no longer holds.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agentport_relay::crypto::Identity;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::remote::RemoteCommandError;

const IDENTITY_VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IdentityFile {
    version: u8,
    private_key: String,
}

pub struct ClientIdentityStore {
    path: PathBuf,
    cached: Mutex<Option<Arc<Identity>>>,
}

impl ClientIdentityStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            cached: Mutex::new(None),
        }
    }

    /// Loads (or generates and persists) the client identity. The first call
    /// writes the file atomically with owner-only permissions; later calls
    /// return the cached identity.
    pub fn identity(&self) -> Result<Arc<Identity>, RemoteCommandError> {
        let mut cached = self.cached.lock().unwrap();
        if let Some(identity) = cached.as_ref() {
            return Ok(Arc::clone(identity));
        }
        let identity = match self.read_persisted() {
            Some(identity) => Arc::new(identity),
            None => {
                let identity = Arc::new(Identity::generate().map_err(|error| {
                    RemoteCommandError::new("identity_generate_failed", error.to_string())
                })?);
                self.persist(identity.as_ref())?;
                identity
            }
        };
        *cached = Some(Arc::clone(&identity));
        Ok(identity)
    }

    /// A missing or unreadable file yields `None` (first use); a corrupt but
    /// present file is quarantined and also yields `None` so a fresh identity
    /// replaces it instead of failing closed forever.
    fn read_persisted(&self) -> Option<Identity> {
        let bytes = std::fs::read(&self.path).ok()?;
        let parsed: Result<IdentityFile, _> = serde_json::from_slice(&bytes);
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(_) => {
                let quarantine = self.path.with_extension("corrupt");
                let _ = std::fs::rename(&self.path, &quarantine);
                return None;
            }
        };
        if parsed.version != IDENTITY_VERSION {
            return None;
        }
        let private = base64::engine::general_purpose::STANDARD
            .decode(parsed.private_key.as_bytes())
            .ok()?;
        Identity::from_private(zeroize::Zeroizing::new(private)).ok()
    }

    fn persist(&self, identity: &Identity) -> Result<(), RemoteCommandError> {
        let directory = self.path.parent().ok_or_else(|| {
            RemoteCommandError::new("identity_storage_failed", "identity path has no parent")
        })?;
        std::fs::create_dir_all(directory).map_err(|error| {
            RemoteCommandError::new("identity_storage_failed", error.to_string())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700));
        }
        let document = IdentityFile {
            version: IDENTITY_VERSION,
            private_key: base64::engine::general_purpose::STANDARD.encode(identity.private_bytes()),
        };
        let bytes = serde_json::to_vec(&document).map_err(|error| {
            RemoteCommandError::new("identity_storage_failed", error.to_string())
        })?;
        let staging = self.path.with_extension("tmp");
        std::fs::write(&staging, &bytes).map_err(|error| {
            RemoteCommandError::new("identity_storage_failed", error.to_string())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&staging, &self.path)
            .map_err(|error| RemoteCommandError::new("identity_storage_failed", error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_round_trips_and_caches() {
        let dir = tempfile::tempdir().unwrap();
        let store = ClientIdentityStore::new(dir.path().join("devices").join("identity.json"));
        let first = store.identity().unwrap();
        let second = store.identity().unwrap();
        assert!(Arc::ptr_eq(&first, &second), "identity must be cached");
        let reloaded = ClientIdentityStore::new(dir.path().join("devices").join("identity.json"));
        let third = reloaded.identity().unwrap();
        assert_eq!(first.public_key(), third.public_key());
    }

    #[cfg(unix)]
    #[test]
    fn persisted_file_and_directory_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = ClientIdentityStore::new(dir.path().join("devices").join("identity.json"));
        store.identity().unwrap();
        let file_mode = std::fs::metadata(dir.path().join("devices").join("identity.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let dir_mode = std::fs::metadata(dir.path().join("devices"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(file_mode, 0o600);
        assert_eq!(dir_mode, 0o700);
    }

    #[test]
    fn corrupt_file_is_quarantined_and_regenerated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices").join("identity.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not-json{{").unwrap();
        let store = ClientIdentityStore::new(path.clone());
        let identity = store.identity().unwrap();
        assert!(!identity.public_key().is_empty());
        assert!(
            path.with_extension("corrupt").is_file(),
            "corrupt file must be quarantined, not silently overwritten"
        );
    }

    #[test]
    fn wrong_version_regenerates() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices").join("identity.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({
                "version": 99,
                "privateKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
            }))
            .unwrap(),
        )
        .unwrap();
        let store = ClientIdentityStore::new(path);
        assert!(store.identity().is_ok());
    }
}
