//! Credential broker (PRD 3.7). macOS keeps Secret values in the app's
//! owner-only data directory; Linux uses the freedesktop Secret Service via
//! the `keyring` crate. macOS no longer touches the login Keychain, so app
//! updates cannot re-trigger the system authorization dialog.
//!
//! HARD RULES:
//! - Secret values live in memory only inside `SecretValue` (zeroized on drop),
//!   flow: backend -> broker -> host spawn env. NEVER into SQLite, logs,
//!   argv, frontend state, search index or backups.
//! - The macOS file backend is deliberately owner-only (0700 directory, 0600
//!   files) and excluded from full-data backups. When the backend is
//!   unavailable, the feature is disabled and the UI explains (failure path A).
//! - Secrets shorter than redact::MIN_SECRET_LEN are rejected (unfingerprintable).

use crate::error::{CoreError, Result};
use crate::models::*;
use crate::paths::AppPaths;
use crate::{ids, redact};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const SERVICE_NAME: &str = "agentport";

/// Wall-clock deadline for backend probes. The first Keychain write for an
/// entry may pop a system authorization dialog; the deadline keeps `detect` /
/// `backend_status` from blocking the caller forever in that case. The macOS
/// file backend answers immediately and never prompts.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SECRET_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendStatus {
    Available(SecretBackend),
    Locked(SecretBackend),
    Unavailable(String),
}

/// A secret value in guarded memory. No Clone, no Debug of the value.
pub struct SecretValue {
    bytes: Vec<u8>,
}

impl SecretValue {
    pub fn new(bytes: Vec<u8>) -> Self {
        SecretValue { bytes }
    }
    pub fn expose(&self) -> &[u8] {
        &self.bytes
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        for b in &mut self.bytes {
            unsafe { std::ptr::write_volatile(b, 0) };
        }
    }
}

impl std::fmt::Debug for SecretValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SecretValue(***)")
    }
}

pub struct CredentialBroker {
    backend: SecretBackend,
    files: Option<FileStore>,
}

/// Owner-only secret files for macOS. The filename is the SHA-256 of the
/// opaque account key, so user-controlled names never become paths.
struct FileStore {
    directory: PathBuf,
}

impl FileStore {
    fn open(root: &Path) -> Result<Self> {
        let root = prepare_private_dir(root)?;
        let directory = prepare_private_dir(&root.join("secrets"))?;
        Ok(Self { directory })
    }

    fn path(&self, account: &str) -> PathBuf {
        let digest = Sha256::digest(account.as_bytes());
        let mut name = String::with_capacity(64);
        for byte in digest {
            use std::fmt::Write as _;
            let _ = write!(name, "{byte:02x}");
        }
        self.directory.join(name)
    }

    fn read(&self, account: &str) -> Result<Option<Vec<u8>>> {
        let file = match std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.path(account))
        {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => {
                return Err(CoreError::SecretStore(
                    "private secret file could not be opened".into(),
                ))
            }
        };
        check_private_file(&file)?;
        let mut bytes = Vec::new();
        file.take(MAX_SECRET_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| CoreError::SecretStore("private secret file read failed".into()))?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_SECRET_BYTES {
            return Err(CoreError::SecretStore(
                "private secret file has an invalid size".into(),
            ));
        }
        Ok(Some(bytes))
    }

    fn write(&self, account: &str, value: &[u8]) -> Result<()> {
        if value.is_empty() || value.len() as u64 > MAX_SECRET_BYTES {
            return Err(CoreError::Validation(
                "secret value has an invalid size".into(),
            ));
        }
        let target = self.path(account);
        let temporary = self.directory.join(format!(".secret-{}", ids::new_uuid()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&temporary)
                .map_err(|_| {
                    CoreError::SecretStore("private secret file could not be created".into())
                })?;
            file.write_all(value)
                .map_err(|_| CoreError::SecretStore("private secret file write failed".into()))?;
            file.sync_all()
                .map_err(|_| CoreError::SecretStore("private secret file sync failed".into()))?;
            std::fs::rename(&temporary, &target)
                .map_err(|_| CoreError::SecretStore("private secret file publish failed".into()))?;
            std::fs::File::open(&self.directory)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| {
                    CoreError::SecretStore("private secrets directory sync failed".into())
                })?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        result
    }

    fn delete(&self, account: &str) -> Result<()> {
        match std::fs::remove_file(self.path(account)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(CoreError::SecretStore(
                "private secret file could not be deleted".into(),
            )),
        }
    }

    fn probe(&self) -> Result<()> {
        let account = format!("agentport-probe-{}", ids::new_uuid());
        let value = format!("agentport-probe-value-{account}");
        self.write(&account, value.as_bytes())?;
        let read = self.read(&account)?;
        let result = match read {
            Some(bytes) if bytes == value.as_bytes() => Ok(()),
            _ => Err(CoreError::SecretStore(
                "secret probe read-back did not match".into(),
            )),
        };
        let cleanup = self.delete(&account);
        result.and(cleanup)
    }
}

fn prepare_private_dir(path: &Path) -> Result<PathBuf> {
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => {
            return Err(CoreError::SecretStoreUnavailable(
                "private secrets directory could not be created".into(),
            ))
        }
    }
    let meta = std::fs::symlink_metadata(path).map_err(|_| {
        CoreError::SecretStoreUnavailable("private secrets directory is unavailable".into())
    })?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(CoreError::SecretStoreUnavailable(
            "private secrets directory must be owner-only".into(),
        ));
    }
    std::fs::canonicalize(path).map_err(|_| {
        CoreError::SecretStoreUnavailable("private secrets directory is unavailable".into())
    })
}

fn check_private_file(file: &std::fs::File) -> Result<()> {
    let meta = file
        .metadata()
        .map_err(|_| CoreError::SecretStore("private secret file metadata failed".into()))?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > MAX_SECRET_BYTES
    {
        return Err(CoreError::SecretStore(
            "private secret file has unsafe ownership or permissions".into(),
        ));
    }
    Ok(())
}

impl CredentialBroker {
    /// Detect the platform backend and verify it answers (macOS private files /
    /// freedesktop Secret Service). Returns Err(SecretStoreUnavailable) otherwise.
    pub fn detect() -> Result<Self> {
        let paths =
            AppPaths::discover().map_err(|e| CoreError::SecretStoreUnavailable(e.to_string()))?;
        Self::detect_at(paths.root())
    }

    pub fn detect_at(root: &Path) -> Result<Self> {
        let broker = Self::open_at(root)?;
        broker.probe_store()?;
        Ok(broker)
    }

    /// Construct without a backend probe. Used by read paths that must not
    /// trigger system prompts (for example the Commit AI key status).
    pub fn open_at(root: &Path) -> Result<Self> {
        let backend = platform_backend().ok_or_else(|| {
            CoreError::SecretStoreUnavailable(format!(
                "unsupported platform {}: only macOS private files and Linux Secret Service are supported",
                std::env::consts::OS
            ))
        })?;
        let files = if backend == SecretBackend::LocalFile {
            Some(FileStore::open(root)?)
        } else {
            None
        };
        Ok(CredentialBroker { backend, files })
    }

    pub fn backend_status() -> BackendStatus {
        match AppPaths::discover() {
            Ok(paths) => Self::backend_status_at(paths.root()),
            Err(e) => BackendStatus::Unavailable(e.to_string()),
        }
    }

    pub fn backend_status_at(root: &Path) -> BackendStatus {
        let Some(backend) = platform_backend() else {
            return BackendStatus::Unavailable(format!(
                "unsupported platform {}: only macOS private files and Linux Secret Service are supported",
                std::env::consts::OS
            ));
        };
        if backend == SecretBackend::LocalFile {
            return match FileStore::open(root).and_then(|store| store.probe()) {
                Ok(()) => BackendStatus::Available(backend),
                Err(e) => BackendStatus::Unavailable(e.to_string()),
            };
        }
        match probe_keyring() {
            Ok(()) => BackendStatus::Available(backend),
            Err(f) if f.is_locked() => BackendStatus::Locked(backend),
            Err(f) => BackendStatus::Unavailable(f.to_string()),
        }
    }

    fn probe_store(&self) -> Result<()> {
        if let Some(files) = &self.files {
            return files.probe();
        }
        probe_keyring().map_err(|f| CoreError::SecretStoreUnavailable(f.to_string()))
    }

    pub fn backend(&self) -> SecretBackend {
        self.backend
    }

    /// Store `value` under (service, account); returns the metadata ref to
    /// persist in SQLite (no value).
    pub fn store(&self, env_name: &str, preset_id: &str, value: &[u8]) -> Result<SecretRef> {
        // All validation happens before any keyring call so a rejected store
        // leaves no trace in the system store.
        if !is_valid_env_name(env_name) {
            return Err(CoreError::Validation(format!(
                "invalid env var name {env_name:?}: must match ^[A-Za-z_][A-Za-z0-9_]*$"
            )));
        }
        if value.len() < redact::MIN_SECRET_LEN {
            return Err(CoreError::Validation(format!(
                "secret of {} byte(s) is shorter than MIN_SECRET_LEN ({}); too short to fingerprint for redaction",
                value.len(),
                redact::MIN_SECRET_LEN
            )));
        }
        // keyring stores passwords as text; non-UTF-8 values are rejected up
        // front instead of failing later on read-back.
        let text = std::str::from_utf8(value)
            .map_err(|_| CoreError::Validation("secret value must be valid UTF-8".into()))?;
        let account = format!("{preset_id}:{env_name}");
        self.store_account(env_name, account, text)
    }

    /// Write to a unique account first so a failed SQLite/preset transaction
    /// can be compensated without overwriting an already-active credential.
    pub fn store_staged(&self, env_name: &str, preset_id: &str, value: &[u8]) -> Result<SecretRef> {
        if !is_valid_env_name(env_name) {
            return Err(CoreError::Validation(
                "invalid environment variable name".into(),
            ));
        }
        if value.len() < redact::MIN_SECRET_LEN {
            return Err(CoreError::Validation(
                "secret is too short for redaction".into(),
            ));
        }
        let text = std::str::from_utf8(value)
            .map_err(|_| CoreError::Validation("secret value must be valid UTF-8".into()))?;
        let account = format!("{preset_id}:{env_name}:{}", ids::new_uuid());
        self.store_account(env_name, account, text)
    }

    fn store_account(&self, env_name: &str, account: String, text: &str) -> Result<SecretRef> {
        if let Some(files) = &self.files {
            files.write(&account, text.as_bytes())?;
        } else {
            let entry =
                keyring::Entry::new(SERVICE_NAME, &account).map_err(|e| store_err("entry", e))?;
            entry
                .set_password(text)
                .map_err(|e| store_err("set_password", e))?;
        }
        Ok(SecretRef {
            id: ids::new_id("sec"),
            env_name: env_name.to_string(),
            backend: self.backend,
            service: SERVICE_NAME.to_string(),
            account,
            updated_at: Utc::now(),
        })
    }

    pub fn load(&self, secret_ref: &SecretRef) -> Result<SecretValue> {
        if let Some(files) = &self.files {
            return files
                .read(&secret_ref.account)?
                .map(SecretValue::new)
                .ok_or_else(|| {
                    CoreError::NotFound(format!(
                        "no secret in store for account {:?}",
                        secret_ref.account
                    ))
                });
        }
        let entry = keyring::Entry::new(&secret_ref.service, &secret_ref.account)
            .map_err(|e| store_err("entry", e))?;
        match entry.get_password() {
            Ok(password) => Ok(SecretValue::new(password.into_bytes())),
            Err(keyring::Error::NoEntry) => Err(CoreError::NotFound(format!(
                "no secret in store for account {:?}",
                secret_ref.account
            ))),
            Err(e) => Err(store_err("get_password", e)),
        }
    }

    pub fn delete(&self, secret_ref: &SecretRef) -> Result<()> {
        if let Some(files) = &self.files {
            return files.delete(&secret_ref.account);
        }
        let entry = keyring::Entry::new(&secret_ref.service, &secret_ref.account)
            .map_err(|e| store_err("entry", e))?;
        match entry.delete_credential() {
            // Deleting a missing entry is a no-op so deletes stay idempotent.
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_err("delete_credential", e)),
        }
    }
}

/// Load all secrets for a preset into (env_name, SecretValue) pairs for host
/// spawn. Any failure aborts the launch (PRD failure path B) — no partial env.
pub fn load_preset_secrets(
    broker: &CredentialBroker,
    refs: &[SecretRef],
) -> Result<Vec<(String, SecretValue)>> {
    let mut out = Vec::with_capacity(refs.len());
    for secret_ref in refs {
        // All-or-nothing: on error the `?` aborts and every SecretValue loaded
        // so far is dropped (and zeroized) as the error propagates.
        let value = broker.load(secret_ref)?;
        out.push((secret_ref.env_name.clone(), value));
    }
    Ok(out)
}

/// Compile-time platform -> backend mapping. macOS uses owner-only files so
/// replacing the app cannot re-trigger Keychain authorization; Linux keeps the
/// freedesktop Secret Service. No other OS has a supported backend.
fn platform_backend() -> Option<SecretBackend> {
    if cfg!(target_os = "macos") {
        Some(SecretBackend::LocalFile)
    } else if cfg!(target_os = "linux") {
        Some(SecretBackend::LinuxSecretService)
    } else {
        None
    }
}

fn is_valid_env_name(name: &str) -> bool {
    // ^[A-Za-z_][A-Za-z0-9_]*$
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Map a keyring failure to a CoreError. `NoStorageAccess` means the store
/// exists but cannot be reached right now (locked keychain / locked Secret
/// Service collection) -> SecretStoreUnavailable, so callers disable the
/// feature instead of falling back to plaintext. Everything else is an
/// operational error -> SecretStore.
fn store_err(context: &str, e: keyring::Error) -> CoreError {
    match e {
        keyring::Error::NoStorageAccess(_) => {
            CoreError::SecretStoreUnavailable(format!("{context}: {e}"))
        }
        other => CoreError::SecretStore(format!("{context}: {other}")),
    }
}

/// 8 hex chars of randomness for one-time probe/test account names.
fn random_tag() -> String {
    ids::new_uuid()
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(8)
        .collect()
}

/// Why a backend probe failed. Kept structured (instead of one flattened
/// message) so `backend_status` can distinguish Locked from Unavailable.
enum ProbeFailure {
    /// A keyring call returned an error; classified by keyring's error kind.
    Keyring(keyring::Error),
    /// Read-back differed from the value just written.
    Mismatch,
    /// Deadline exceeded; the probe thread was abandoned (see probe_keyring).
    Timeout,
    /// Could not spawn the probe helper thread.
    Spawn(std::io::Error),
}

impl ProbeFailure {
    /// Best-effort locked detection. There is no portable "locked" signal:
    /// keyring maps a locked Secret Service collection to `NoStorageAccess`,
    /// while on macOS a locked keychain shows up either as `NoStorageAccess`
    /// (errSecNotAvailable / errSecNoSuchKeychain / ...) or as a
    /// `PlatformFailure` wrapping errSecInteractionNotAllowed (-25308), so the
    /// message text is scanned as a fallback. Expect platform differences.
    fn is_locked(&self) -> bool {
        match self {
            ProbeFailure::Keyring(e) => {
                if matches!(e, keyring::Error::NoStorageAccess(_)) {
                    return true;
                }
                let msg = e.to_string().to_ascii_lowercase();
                msg.contains("locked") || msg.contains("interaction not allowed")
            }
            _ => false,
        }
    }
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeFailure::Keyring(e) => write!(f, "{e}"),
            ProbeFailure::Mismatch => {
                write!(f, "probe read-back did not match the written value")
            }
            ProbeFailure::Timeout => write!(
                f,
                "probe timed out after {}s; a system authorization prompt may be \
                 blocking and the abandoned probe thread may still be waiting on it",
                PROBE_TIMEOUT.as_secs()
            ),
            ProbeFailure::Spawn(e) => write!(f, "cannot spawn probe thread: {e}"),
        }
    }
}

/// Verify the backend answers with a write/read/delete roundtrip under a
/// wall-clock deadline. Runs on a helper thread so a system authorization
/// dialog cannot block the caller; on timeout the thread is abandoned (it may
/// stay parked inside the keyring call until the dialog is dismissed) and the
/// backend is reported unavailable.
fn probe_keyring() -> std::result::Result<(), ProbeFailure> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("agentport-secret-probe".into())
        .spawn(move || {
            let _ = tx.send(probe_roundtrip());
        })
        .map_err(ProbeFailure::Spawn)?;
    match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(result) => result,
        Err(_) => Err(ProbeFailure::Timeout),
    }
}

/// set + get + delete roundtrip against a random one-time account. The account
/// is deleted before returning, so probing leaves no trace in the store even
/// when the write triggered a first-access authorization dialog.
fn probe_roundtrip() -> std::result::Result<(), ProbeFailure> {
    let tag = random_tag();
    let account = format!("agentport-probe-{tag}");
    let value = format!("agentport-probe-value-{tag}");
    let entry = keyring::Entry::new(SERVICE_NAME, &account).map_err(ProbeFailure::Keyring)?;
    let result = entry
        .set_password(&value)
        .and_then(|()| entry.get_password())
        .map_err(ProbeFailure::Keyring)
        .and_then(|got| {
            if got == value {
                Ok(())
            } else {
                Err(ProbeFailure::Mismatch)
            }
        });
    // Always attempt cleanup, even when the roundtrip failed mid-way.
    let cleanup = entry.delete_credential().map_err(ProbeFailure::Keyring);
    result.and(cleanup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn test_file_broker() -> (tempfile::TempDir, CredentialBroker) {
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let broker = CredentialBroker::detect_at(temp.path())
            .expect("private file backend must be available");
        (temp, broker)
    }

    #[test]
    fn private_file_store_roundtrips_overwrites_and_rejects_unsafe_files() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let store = FileStore::open(temp.path()).unwrap();
        store.write("agentport-test:TOKEN", b"value-1234").unwrap();
        assert_eq!(
            store.read("agentport-test:TOKEN").unwrap().unwrap(),
            b"value-1234"
        );
        let path = store.path("agentport-test:TOKEN");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );

        // Same account overwrites atomically (Commit AI key replacement).
        store
            .write("agentport-test:TOKEN", b"newer-value-5678")
            .unwrap();
        assert_eq!(
            store.read("agentport-test:TOKEN").unwrap().unwrap(),
            b"newer-value-5678"
        );

        store.delete("agentport-test:TOKEN").unwrap();
        store.delete("agentport-test:TOKEN").unwrap();
        assert!(store.read("agentport-test:TOKEN").unwrap().is_none());

        // A symlink planted at the hashed filename must never be followed.
        std::fs::remove_file(&path).ok();
        let sentinel = temp.path().join("sentinel");
        std::fs::write(&sentinel, "unchanged").unwrap();
        std::os::unix::fs::symlink(&sentinel, &path).unwrap();
        assert!(store.read("agentport-test:TOKEN").is_err());
        assert_eq!(std::fs::read_to_string(&sentinel).unwrap(), "unchanged");
    }

    #[test]
    fn private_file_store_requires_owner_only_directories() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            FileStore::open(temp.path()),
            Err(CoreError::SecretStoreUnavailable(_))
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_broker_uses_private_files_and_roundtrips() {
        let (_temp, broker) = test_file_broker();
        assert_eq!(broker.backend(), SecretBackend::LocalFile);
        assert_eq!(SecretBackend::LocalFile.as_str(), "local_file");

        // Emoji + symbols; must survive the store as exact bytes.
        let value = "t0ken-🔑-pä$$wörd-!@#";
        let secret_ref = broker
            .store("TEST_TOKEN", "agentport-test", value.as_bytes())
            .expect("store");
        assert!(secret_ref.id.starts_with("sec_"));
        assert_eq!(secret_ref.env_name, "TEST_TOKEN");
        assert_eq!(secret_ref.service, SERVICE_NAME);
        assert_eq!(secret_ref.account, "agentport-test:TEST_TOKEN");

        let loaded = broker.load(&secret_ref).expect("load");
        assert_eq!(loaded.expose(), value.as_bytes());

        // Re-storing the same account overwrites in place.
        let newer = "n3wer-🔒-value";
        let updated = broker
            .store("TEST_TOKEN", "agentport-test", newer.as_bytes())
            .expect("re-store overwrites");
        assert_eq!(
            broker.load(&updated).expect("reload").expose(),
            newer.as_bytes()
        );

        broker.delete(&updated).expect("delete");
        broker.delete(&updated).expect("delete is idempotent");
        assert!(
            matches!(broker.load(&updated), Err(CoreError::NotFound(_))),
            "load after delete must be NotFound"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn store_rejects_invalid_inputs_without_touching_the_store() {
        let (_temp, broker) = test_file_broker();

        // Shorter than redact::MIN_SECRET_LEN (3 bytes).
        assert!(matches!(
            broker.store("VALID_NAME", "agentport-test", b"abc"),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            broker.store("HAS SPACE", "agentport-test", b"long-enough-value"),
            Err(CoreError::Validation(_))
        ));
        assert!(matches!(
            broker.store("1KEY", "agentport-test", b"long-enough-value"),
            Err(CoreError::Validation(_))
        ));
        // Non-UTF-8 value.
        assert!(matches!(
            broker.store("VALID_NAME", "agentport-test", &[0xff, 0xfe, 0xfd, 0xfc]),
            Err(CoreError::Validation(_))
        ));

        let leftover = SecretRef {
            id: ids::new_id("sec"),
            env_name: "VALID_NAME".into(),
            backend: SecretBackend::LocalFile,
            service: SERVICE_NAME.into(),
            account: "agentport-test:VALID_NAME".into(),
            updated_at: Utc::now(),
        };
        assert!(matches!(
            broker.load(&leftover),
            Err(CoreError::NotFound(_))
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn load_preset_secrets_is_all_or_nothing() {
        let (_temp, broker) = test_file_broker();
        let good = broker
            .store("GOOD_KEY", "agentport-test", b"good-value-1234")
            .expect("store");
        let missing = SecretRef {
            id: ids::new_id("sec"),
            env_name: "MISSING_KEY".into(),
            backend: SecretBackend::LocalFile,
            service: SERVICE_NAME.into(),
            account: "agentport-test:MISSING_KEY".into(),
            updated_at: Utc::now(),
        };

        let result = load_preset_secrets(&broker, &[good.clone(), missing]);
        assert!(
            matches!(result, Err(CoreError::NotFound(_))),
            "one failing ref must fail the whole load (no partial env)"
        );

        // Sanity: the good ref alone loads fine.
        let single = load_preset_secrets(&broker, &[good]).expect("good ref loads");
        assert_eq!(single.len(), 1);
        assert_eq!(single[0].0, "GOOD_KEY");
        assert_eq!(single[0].1.expose(), b"good-value-1234");
    }

    #[test]
    fn secret_ref_json_contains_metadata_only() {
        let secret_ref = SecretRef {
            id: "sec_test".into(),
            env_name: "AUDIT_KEY".into(),
            backend: SecretBackend::LocalFile,
            service: SERVICE_NAME.into(),
            account: "agentport-test:AUDIT_KEY".into(),
            updated_at: Utc::now(),
        };
        let json = serde_json::to_string(&secret_ref).expect("serialize");
        assert!(
            !json.contains("sup3r-secret"),
            "SecretRef JSON must never embed a value: {json}"
        );
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parse");
        for key in parsed.as_object().expect("object").keys() {
            assert!(
                [
                    "id",
                    "envName",
                    "backend",
                    "service",
                    "account",
                    "updatedAt"
                ]
                .contains(&key.as_str()),
                "unexpected field in SecretRef JSON: {key}"
            );
        }
        assert_eq!(parsed["backend"], "local_file");
    }

    #[test]
    fn drop_zeroizes_the_buffer() {
        // Soundness note: reading the buffer AFTER the SecretValue is dropped
        // is not possible — the Vec frees it, and the allocator immediately
        // writes free-list linkage into the freed block (verified: a naive
        // read-after-free fails on macOS). Instead this test installs a
        // test-only global allocator that inspects the block INSIDE `dealloc`
        // — the one moment where SecretValue's destructor has already run
        // (fields drop after the custom destructor) but the memory is still
        // legally readable.
        zeroize_probe::arm();
        let mut bytes = Vec::with_capacity(zeroize_probe::PROBE_SIZE);
        bytes.resize(zeroize_probe::PROBE_SIZE, 0xAA);
        let value = SecretValue::new(bytes);
        assert_eq!(value.expose()[0], 0xAA);
        drop(value); // zeroize runs here; the Vec's free follows immediately
        let state = zeroize_probe::disarm();
        assert_eq!(
            state, 1,
            "SecretValue buffer must be all-zero when freed (0 = probe never saw the free, 2 = non-zero byte leaked)"
        );
    }

    /// Test-only allocator probe for `drop_zeroizes_the_buffer`: while armed,
    /// it records the first allocation of exactly PROBE_SIZE bytes (align 1)
    /// and, when that block is freed, checks whether its bytes are all zero
    /// before forwarding to the system allocator.
    mod zeroize_probe {
        use std::alloc::{GlobalAlloc, Layout, System};
        use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};

        /// 1 MiB + 1: deliberately odd so no other allocation in this small
        /// test binary collides with the probe while it is armed.
        pub const PROBE_SIZE: usize = 1024 * 1024 + 1;

        static ARMED: AtomicBool = AtomicBool::new(false);
        static WATCH_PTR: AtomicUsize = AtomicUsize::new(0);
        /// 0 = free not observed yet, 1 = block was all-zero, 2 = non-zero byte.
        static FREE_STATE: AtomicU8 = AtomicU8::new(0);

        pub struct Probe;

        unsafe impl GlobalAlloc for Probe {
            unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
                let ptr = System.alloc(layout);
                if ARMED.load(Ordering::SeqCst)
                    && layout.size() == PROBE_SIZE
                    && layout.align() == 1
                    && !ptr.is_null()
                {
                    let _ = WATCH_PTR.compare_exchange(
                        0,
                        ptr as usize,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                }
                ptr
            }

            unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
                if layout.size() == PROBE_SIZE
                    && layout.align() == 1
                    && ptr as usize != 0
                    && ptr as usize == WATCH_PTR.load(Ordering::SeqCst)
                {
                    // Sound: the block is still allocated to us until we
                    // forward to System::dealloc below.
                    let buf = std::slice::from_raw_parts(ptr, layout.size());
                    let all_zero = buf.iter().all(|&b| b == 0);
                    FREE_STATE.store(if all_zero { 1 } else { 2 }, Ordering::SeqCst);
                    WATCH_PTR.store(0, Ordering::SeqCst);
                }
                System.dealloc(ptr, layout)
            }
        }

        pub fn arm() {
            FREE_STATE.store(0, Ordering::SeqCst);
            WATCH_PTR.store(0, Ordering::SeqCst);
            ARMED.store(true, Ordering::SeqCst);
        }

        pub fn disarm() -> u8 {
            ARMED.store(false, Ordering::SeqCst);
            FREE_STATE.load(Ordering::SeqCst)
        }
    }

    #[global_allocator]
    static ZEROIZE_PROBE_ALLOC: zeroize_probe::Probe = zeroize_probe::Probe;

    #[test]
    fn secret_value_debug_never_shows_bytes() {
        let value = SecretValue::new(b"hunter2hunter2".to_vec());
        let dbg = format!("{value:?}");
        assert!(!dbg.contains("hunter2"));
        assert_eq!(dbg, "SecretValue(***)");
    }
}
