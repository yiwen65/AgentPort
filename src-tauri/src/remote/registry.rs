//! The desktop's remote-device registry.
//!
//! Persists `DeviceProfile[]` at `<data-root>/devices/devices.json` (0700
//! dir, 0600 file, atomic temp+rename writes — the same conventions as
//! `tofu.rs` and `identity.rs`). Implements the manager's `DeviceResolver`
//! so `remote_connect(deviceId)` works for every persisted profile, and owns
//! the add/remove/rename flows behind the device management commands.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agentport_relay::protocol::validate_name;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::remote::credentials::{credential_account, DeviceCredentialStore};
use crate::remote::manager::{DeviceConnectionInfo, DeviceResolver, SshProbeOutcome, SshProber};
use crate::remote::ssh::{SshSecret, SshTarget};
use crate::remote::types::{DeviceProfile, DeviceTransportProfile};
use crate::remote::RemoteCommandError;

const REGISTRY_VERSION: u8 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    version: u8,
    devices: Vec<DeviceProfile>,
}

pub struct DeviceRegistry {
    path: PathBuf,
    credentials: Arc<dyn DeviceCredentialStore>,
    state: Mutex<Vec<DeviceProfile>>,
}

impl DeviceRegistry {
    /// Opens (or initializes) the registry file. A corrupt file is
    /// quarantined (`devices.corrupt`) and reported as a structured error —
    /// the caller may simply call `open` again to start empty, so startup
    /// never panics on a damaged registry.
    pub fn open(
        path: PathBuf,
        credentials: Arc<dyn DeviceCredentialStore>,
    ) -> Result<Arc<Self>, RemoteCommandError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                RemoteCommandError::new("registry_storage_failed", error.to_string())
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
            }
        }
        let devices = match std::fs::read(&path) {
            Ok(bytes) => {
                let document: RegistryDocument =
                    serde_json::from_slice(&bytes).map_err(|error| {
                        let quarantine = path.with_extension("corrupt");
                        let _ = std::fs::rename(&path, &quarantine);
                        RemoteCommandError::new(
                            "registry_corrupt",
                            format!(
                                "devices.json is unreadable ({error}); quarantined to {}",
                                quarantine.display()
                            ),
                        )
                    })?;
                if document.version != REGISTRY_VERSION {
                    return Err(RemoteCommandError::new(
                        "registry_version_unknown",
                        format!("devices.json version {} is unsupported", document.version),
                    ));
                }
                document.devices
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => {
                return Err(RemoteCommandError::new(
                    "registry_read_failed",
                    error.to_string(),
                ))
            }
        };
        Ok(Arc::new(Self {
            path,
            credentials,
            state: Mutex::new(devices),
        }))
    }

    pub fn credentials(&self) -> &Arc<dyn DeviceCredentialStore> {
        &self.credentials
    }

    pub fn list(&self) -> Vec<DeviceProfile> {
        self.state.lock().unwrap().clone()
    }

    pub fn get(&self, device_id: &str) -> Option<DeviceProfile> {
        self.state
            .lock()
            .unwrap()
            .iter()
            .find(|profile| profile.id == device_id)
            .cloned()
    }

    /// Inserts or replaces a profile and persists atomically. Concurrent
    /// upserts serialize on the state mutex, so the last completed write
    /// wins with no interleaved partial states.
    pub fn upsert(&self, profile: DeviceProfile) -> Result<(), RemoteCommandError> {
        validate_name(&profile.name)
            .map_err(|error| RemoteCommandError::new("device_name_invalid", error.to_string()))?;
        let mut devices = self.state.lock().unwrap();
        match devices
            .iter_mut()
            .find(|existing| existing.id == profile.id)
        {
            Some(existing) => *existing = profile,
            None => devices.push(profile),
        }
        self.persist_locked(&devices)
    }

    /// Removes a profile, returning the removed record so callers can run
    /// compensating cleanup (credential deletion) with full knowledge.
    pub fn remove(&self, device_id: &str) -> Result<DeviceProfile, RemoteCommandError> {
        let mut devices = self.state.lock().unwrap();
        let index = devices
            .iter()
            .position(|profile| profile.id == device_id)
            .ok_or_else(|| {
                RemoteCommandError::new(
                    "device_not_found",
                    format!("no device registered as {device_id}"),
                )
            })?;
        let removed = devices.remove(index);
        self.persist_locked(&devices)?;
        Ok(removed)
    }

    pub fn rename(&self, device_id: &str, name: &str) -> Result<(), RemoteCommandError> {
        validate_name(name)
            .map_err(|error| RemoteCommandError::new("device_name_invalid", error.to_string()))?;
        let mut devices = self.state.lock().unwrap();
        let profile = devices
            .iter_mut()
            .find(|profile| profile.id == device_id)
            .ok_or_else(|| {
                RemoteCommandError::new(
                    "device_not_found",
                    format!("no device registered as {device_id}"),
                )
            })?;
        profile.name = name.to_string();
        self.persist_locked(&devices)
    }

    /// Success stamps `last_connected_at` and clears `last_error`; failure
    /// records `last_error` and keeps the previous success timestamp.
    /// Unknown ids are ignored (the device may have been removed mid-dial).
    pub fn update_connect_outcome(&self, device_id: &str, error: Option<&RemoteCommandError>) {
        let mut devices = self.state.lock().unwrap();
        let Some(profile) = devices.iter_mut().find(|profile| profile.id == device_id) else {
            return;
        };
        match error {
            None => {
                profile.last_connected_at = Some(chrono::Utc::now().to_rfc3339());
                profile.last_error = None;
            }
            Some(error) => {
                profile.last_error = Some(format!("{}: {}", error.code, error.message));
            }
        }
        // Outcome bookkeeping must never break the connection path; a
        // persist failure only loses the timestamp update.
        let _ = self.persist_locked(&devices);
    }

    /// Probe-first SSH onboarding: validate the draft, prove the device is
    /// reachable and protocol-compatible via `manager`'s prober, then persist
    /// the keychain secret and the profile (credential first so a profile
    /// write failure can roll the secret back).
    pub fn add_ssh_device(
        &self,
        prober: &dyn SshProber,
        draft: DeviceAddSshDraft,
    ) -> Result<DeviceProfile, RemoteCommandError> {
        let hostname = draft.hostname.trim().to_string();
        if hostname.is_empty() || hostname.chars().any(char::is_whitespace) {
            return Err(RemoteCommandError::new(
                "device_draft_invalid",
                "hostname must be non-empty and contain no whitespace",
            ));
        }
        let username = draft.username.trim().to_string();
        if username.is_empty() {
            return Err(RemoteCommandError::new(
                "device_draft_invalid",
                "username must be non-empty",
            ));
        }
        if draft.port == 0 {
            return Err(RemoteCommandError::new(
                "device_draft_invalid",
                "port must be between 1 and 65535",
            ));
        }
        let name = match &draft.name {
            Some(name) => {
                validate_name(name).map_err(|error| {
                    RemoteCommandError::new("device_name_invalid", error.to_string())
                })?;
                name.clone()
            }
            None => hostname.clone(),
        };
        let secret = draft.auth.into_secret()?;
        let target = SshTarget {
            host: hostname.clone(),
            port: draft.port,
            username: username.clone(),
        };
        // The probe maps failures onto the distinct add-device error family
        // (device_unreachable/auth_failed/host_key_changed/bridge_missing/
        // protocol_incompatible); nothing is persisted unless it succeeds.
        let _outcome: SshProbeOutcome = prober.probe(&target, &secret)?;
        let id = format!(
            "dev_{}",
            agentport_relay::protocol::identifier()
                .map_err(|error| RemoteCommandError::new("device_id_failed", error.to_string()))?
        );
        let profile = DeviceProfile {
            id: id.clone(),
            name,
            transport: DeviceTransportProfile::Ssh {
                hostname,
                port: draft.port,
                username,
                auth_ref: credential_account(&id),
            },
            created_at: chrono::Utc::now().to_rfc3339(),
            last_connected_at: None,
            last_error: None,
        };
        self.credentials.store(&id, &secret)?;
        if let Err(error) = self.upsert(profile.clone()) {
            let _ = self.credentials.delete(&id);
            return Err(error);
        }
        Ok(profile)
    }

    fn persist_locked(&self, devices: &[DeviceProfile]) -> Result<(), RemoteCommandError> {
        let document = RegistryDocument {
            version: REGISTRY_VERSION,
            devices: devices.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
            RemoteCommandError::new("registry_storage_failed", error.to_string())
        })?;
        let staging = self.path.with_extension("tmp");
        std::fs::write(&staging, &bytes).map_err(|error| {
            RemoteCommandError::new("registry_storage_failed", error.to_string())
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&staging, &self.path)
            .map_err(|error| RemoteCommandError::new("registry_storage_failed", error.to_string()))
    }
}

impl DeviceResolver for DeviceRegistry {
    fn resolve(&self, device_id: &str) -> Result<DeviceConnectionInfo, RemoteCommandError> {
        let profile = self.get(device_id).ok_or_else(|| {
            RemoteCommandError::new(
                "device_not_found",
                format!("no device registered as {device_id}"),
            )
        })?;
        let secret = match &profile.transport {
            DeviceTransportProfile::Ssh { .. } => {
                Some(self.credentials.load(device_id)?.ok_or_else(|| {
                    RemoteCommandError::new(
                        "credential_missing",
                        format!("no stored credential for {device_id}"),
                    )
                })?)
            }
            DeviceTransportProfile::Relay { .. } => None,
        };
        profile.connection_info(secret)
    }

    fn record_connect_outcome(&self, device_id: &str, error: Option<&RemoteCommandError>) {
        self.update_connect_outcome(device_id, error);
    }
}

/// `device_add_ssh` draft: secret material arrives as `Zeroizing` strings
/// and is converted into an `SshSecret` exactly once.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeviceAddSshDraft {
    #[serde(default)]
    pub name: Option<String>,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub auth: DeviceSshAuthDraft,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeviceSshAuthDraft {
    #[serde(rename = "password")]
    Password { password: Zeroizing<String> },
    #[serde(rename = "privateKey")]
    PrivateKey {
        pem: Zeroizing<String>,
        #[serde(default)]
        passphrase: Option<Zeroizing<String>>,
    },
}

impl DeviceSshAuthDraft {
    fn into_secret(self) -> Result<SshSecret, RemoteCommandError> {
        match self {
            DeviceSshAuthDraft::Password { password } => {
                if password.as_str().is_empty() {
                    return Err(RemoteCommandError::new(
                        "device_draft_invalid",
                        "password must be non-empty",
                    ));
                }
                Ok(SshSecret::Password(password))
            }
            DeviceSshAuthDraft::PrivateKey { pem, passphrase } => {
                if !pem.as_str().contains("PRIVATE KEY") {
                    return Err(RemoteCommandError::new(
                        "device_draft_invalid",
                        "private key must be a PEM block containing a private key",
                    ));
                }
                Ok(SshSecret::PrivateKey { pem, passphrase })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::credentials::MemoryCredentialStore;
    use crate::remote::manager::{DeviceTransport, RemoteConnectionManager};
    use agentport_core::paths::AppPaths;

    fn registry(dir: &tempfile::TempDir) -> (Arc<DeviceRegistry>, Arc<MemoryCredentialStore>) {
        let credentials = Arc::new(MemoryCredentialStore::default());
        let registry = DeviceRegistry::open(
            dir.path().join("devices").join("devices.json"),
            credentials.clone(),
        )
        .unwrap();
        (registry, credentials)
    }

    fn ssh_profile(id: &str) -> DeviceProfile {
        DeviceProfile {
            id: id.to_string(),
            name: format!("Box {id}"),
            transport: DeviceTransportProfile::Ssh {
                hostname: "192.168.1.10".to_string(),
                port: 22,
                username: "alice".to_string(),
                auth_ref: credential_account(id),
            },
            created_at: "2026-09-23T00:00:00Z".to_string(),
            last_connected_at: None,
            last_error: None,
        }
    }

    #[test]
    fn crud_round_trip_with_atomic_owner_only_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, _) = registry(&dir);
        assert!(registry.list().is_empty());
        registry.upsert(ssh_profile("dev_a")).unwrap();
        registry.upsert(ssh_profile("dev_b")).unwrap();
        assert_eq!(registry.list().len(), 2);
        // Re-open: state survives.
        let credentials = Arc::new(MemoryCredentialStore::default());
        let reopened =
            DeviceRegistry::open(dir.path().join("devices").join("devices.json"), credentials)
                .unwrap();
        assert_eq!(reopened.list().len(), 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file_mode = std::fs::metadata(dir.path().join("devices").join("devices.json"))
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
        reopened.rename("dev_a", "Renamed box").unwrap();
        assert_eq!(reopened.get("dev_a").unwrap().name, "Renamed box");
        let removed = reopened.remove("dev_a").unwrap();
        assert_eq!(removed.id, "dev_a");
        assert_eq!(reopened.list().len(), 1);
        let error = reopened.remove("dev_a").unwrap_err();
        assert_eq!(error.code, "device_not_found");
    }

    #[test]
    fn corrupt_registry_is_quarantined_then_reopens_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices").join("devices.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"not-json{{").unwrap();
        let credentials = Arc::new(MemoryCredentialStore::default());
        let error = DeviceRegistry::open(path.clone(), credentials.clone())
            .err()
            .expect("corrupt registry must be rejected");
        assert_eq!(error.code, "registry_corrupt");
        assert!(path.with_extension("corrupt").is_file());
        let reopened = DeviceRegistry::open(path, credentials).unwrap();
        assert!(reopened.list().is_empty());
    }

    #[test]
    fn unknown_registry_version_is_a_structured_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices").join("devices.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&serde_json::json!({"version": 99, "devices": []})).unwrap(),
        )
        .unwrap();
        let error = DeviceRegistry::open(path, Arc::new(MemoryCredentialStore::default()))
            .err()
            .expect("unknown version must be rejected");
        assert_eq!(error.code, "registry_version_unknown");
    }

    #[test]
    fn connect_outcome_transitions_are_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, _) = registry(&dir);
        registry.upsert(ssh_profile("dev_a")).unwrap();
        registry.update_connect_outcome(
            "dev_a",
            Some(&RemoteCommandError::new("device_unreachable", "no route")),
        );
        let profile = registry.get("dev_a").unwrap();
        assert!(profile.last_connected_at.is_none());
        assert_eq!(
            profile.last_error.as_deref(),
            Some("device_unreachable: no route")
        );
        registry.update_connect_outcome("dev_a", None);
        let profile = registry.get("dev_a").unwrap();
        assert!(profile.last_connected_at.is_some());
        assert!(profile.last_error.is_none());
        // Unknown ids are ignored without touching persisted state.
        registry.update_connect_outcome("dev_missing", None);
    }

    #[test]
    fn concurrent_upserts_serialize_without_loss() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, _) = registry(&dir);
        let mut handles = Vec::new();
        for index in 0..8 {
            let registry = Arc::clone(&registry);
            handles.push(std::thread::spawn(move || {
                registry
                    .upsert(ssh_profile(&format!("dev_{index}")))
                    .unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(registry.list().len(), 8);
    }

    #[test]
    fn resolver_injects_ssh_credentials_and_skips_relay() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, credentials) = registry(&dir);
        registry.upsert(ssh_profile("dev_ssh")).unwrap();
        // Missing credential is a distinct error.
        let error = registry.resolve("dev_ssh").unwrap_err();
        assert_eq!(error.code, "credential_missing");
        credentials
            .store(
                "dev_ssh",
                &SshSecret::Password(Zeroizing::new("pw".to_string())),
            )
            .unwrap();
        let info = registry.resolve("dev_ssh").unwrap();
        assert_eq!(info.device_id, "dev_ssh");
        assert!(matches!(info.transport, DeviceTransport::Ssh(_)));
        assert!(info.secret.is_some());
        // Relay profiles resolve without any credential.
        let identity = agentport_relay::crypto::Identity::generate().unwrap();
        let peer = identity
            .peer(
                "ws://127.0.0.1:9/v1/relay".to_string(),
                "Relay box".to_string(),
            )
            .unwrap();
        registry
            .upsert(DeviceProfile {
                id: "dev_relay".to_string(),
                name: "Relay box".to_string(),
                transport: DeviceTransportProfile::Relay { peer },
                created_at: "2026-09-23T00:00:00Z".to_string(),
                last_connected_at: None,
                last_error: None,
            })
            .unwrap();
        let info = registry.resolve("dev_relay").unwrap();
        assert!(matches!(info.transport, DeviceTransport::Relay(_)));
        assert!(info.secret.is_none());
        let error = registry.resolve("dev_missing").unwrap_err();
        assert_eq!(error.code, "device_not_found");
    }

    #[test]
    fn record_connect_outcome_goes_through_the_resolver_trait() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, _) = registry(&dir);
        registry.upsert(ssh_profile("dev_a")).unwrap();
        let resolver: &dyn DeviceResolver = registry.as_ref();
        resolver.record_connect_outcome(
            "dev_a",
            Some(&RemoteCommandError::new("auth_failed", "denied")),
        );
        assert!(registry.get("dev_a").unwrap().last_error.is_some());
        resolver.record_connect_outcome("dev_a", None);
        assert!(registry.get("dev_a").unwrap().last_connected_at.is_some());
    }

    struct FakeProber {
        outcome: Mutex<Option<Result<SshProbeOutcome, RemoteCommandError>>>,
        calls: Mutex<Vec<(String, u16, String)>>,
    }

    impl FakeProber {
        fn ok() -> Self {
            Self {
                outcome: Mutex::new(Some(Ok(SshProbeOutcome {
                    server_platform: "linux".to_string(),
                    server_agentport_version: "0.1.2".to_string(),
                }))),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn failing(code: &str) -> Self {
            Self {
                outcome: Mutex::new(Some(Err(RemoteCommandError::new(code, "probe says no")))),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl SshProber for FakeProber {
        fn probe(
            &self,
            target: &SshTarget,
            _secret: &SshSecret,
        ) -> Result<SshProbeOutcome, RemoteCommandError> {
            self.calls.lock().unwrap().push((
                target.host.clone(),
                target.port,
                target.username.clone(),
            ));
            self.outcome.lock().unwrap().take().unwrap()
        }
    }

    fn draft() -> DeviceAddSshDraft {
        DeviceAddSshDraft {
            name: None,
            hostname: " 192.168.1.10 ".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth: DeviceSshAuthDraft::Password {
                password: Zeroizing::new("s3cret".to_string()),
            },
        }
    }

    #[test]
    fn add_ssh_device_probes_then_persists_profile_and_credential() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, credentials) = registry(&dir);
        let prober = FakeProber::ok();
        let profile = registry.add_ssh_device(&prober, draft()).unwrap();
        assert!(profile.id.starts_with("dev_"));
        // Name defaults to the trimmed hostname.
        assert_eq!(profile.name, "192.168.1.10");
        match &profile.transport {
            DeviceTransportProfile::Ssh {
                hostname,
                port,
                username,
                auth_ref,
            } => {
                assert_eq!(hostname, "192.168.1.10");
                assert_eq!(*port, 22);
                assert_eq!(username, "alice");
                assert_eq!(auth_ref, &credential_account(&profile.id));
            }
            _ => panic!("expected ssh transport"),
        }
        assert!(credentials.has(&profile.id));
        assert!(registry.get(&profile.id).is_some());
        let calls = prober.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "192.168.1.10");
    }

    #[test]
    fn add_ssh_device_probe_failures_persist_nothing() {
        for (code, expected) in [
            ("device_unreachable", "device_unreachable"),
            ("auth_failed", "auth_failed"),
            ("host_key_changed", "host_key_changed"),
            ("bridge_missing", "bridge_missing"),
            ("protocol_incompatible", "protocol_incompatible"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let (registry, credentials) = registry(&dir);
            let prober = FakeProber::failing(code);
            let error = registry.add_ssh_device(&prober, draft()).unwrap_err();
            assert_eq!(error.code, expected);
            assert!(registry.list().is_empty(), "{code}: no profile persisted");
            // No device id was ever allocated, so no credential can exist.
            assert!(registry.credentials().load("dev_any").unwrap().is_none());
            drop(credentials);
        }
    }

    #[test]
    fn add_ssh_device_validates_the_draft_before_probing() {
        let dir = tempfile::tempdir().unwrap();
        let (registry, _) = registry(&dir);
        let prober = FakeProber::ok();
        for mutate in [
            (|draft: &mut DeviceAddSshDraft| draft.hostname = "  ".to_string())
                as fn(&mut DeviceAddSshDraft),
            (|draft: &mut DeviceAddSshDraft| draft.hostname = "has space".to_string())
                as fn(&mut DeviceAddSshDraft),
            (|draft: &mut DeviceAddSshDraft| draft.username = " ".to_string())
                as fn(&mut DeviceAddSshDraft),
            (|draft: &mut DeviceAddSshDraft| draft.port = 0) as fn(&mut DeviceAddSshDraft),
            (|draft: &mut DeviceAddSshDraft| {
                draft.auth = DeviceSshAuthDraft::Password {
                    password: Zeroizing::new(String::new()),
                }
            }) as fn(&mut DeviceAddSshDraft),
        ] {
            let mut draft = draft();
            mutate(&mut draft);
            let error = registry.add_ssh_device(&prober, draft).unwrap_err();
            assert_eq!(error.code, "device_draft_invalid");
        }
        let mut draft = draft();
        draft.name = Some("bad\nname".to_string());
        let error = registry.add_ssh_device(&prober, draft).unwrap_err();
        assert_eq!(error.code, "device_name_invalid");
        assert!(prober.calls.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn add_ssh_device_rolls_back_the_credential_when_the_profile_write_fails() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (registry, credentials) = registry(&dir);
        // Make the devices directory unwritable so persist_locked fails.
        let devices_dir = dir.path().join("devices");
        std::fs::set_permissions(&devices_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        let prober = FakeProber::ok();
        let error = registry.add_ssh_device(&prober, draft()).unwrap_err();
        assert_eq!(error.code, "registry_storage_failed");
        assert!(
            credentials.is_empty(),
            "credential must be rolled back when the profile write fails"
        );
        std::fs::set_permissions(&devices_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn draft_deserializes_from_the_frozen_camel_case_contract() {
        let password: DeviceAddSshDraft = serde_json::from_value(serde_json::json!({
            "name": "Linux box",
            "hostname": "192.168.1.10",
            "port": 22,
            "username": "alice",
            "auth": {"kind": "password", "password": "s3cret"}
        }))
        .unwrap();
        assert!(matches!(password.auth, DeviceSshAuthDraft::Password { .. }));
        let key: DeviceAddSshDraft = serde_json::from_value(serde_json::json!({
            "hostname": "192.168.1.10",
            "port": 2222,
            "username": "alice",
            "auth": {"kind": "privateKey", "pem": "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----", "passphrase": "p"}
        }))
        .unwrap();
        match key.auth {
            DeviceSshAuthDraft::PrivateKey { pem, passphrase } => {
                assert!(pem.as_str().contains("OPENSSH"));
                assert!(passphrase.is_some());
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn manager_exposes_the_injected_prober() {
        let dir = tempfile::tempdir().unwrap();
        let manager =
            RemoteConnectionManager::new(&AppPaths::new(dir.path().to_path_buf())).unwrap();
        manager.set_prober(Arc::new(FakeProber::ok()));
        let target = SshTarget {
            host: "192.168.1.10".to_string(),
            port: 22,
            username: "alice".to_string(),
        };
        let secret = SshSecret::Password(Zeroizing::new("pw".to_string()));
        let outcome = manager.ssh_prober().probe(&target, &secret).unwrap();
        assert_eq!(outcome.server_platform, "linux");
    }
}
