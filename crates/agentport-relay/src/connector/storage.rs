//! Connector-only local state. No private keys or deployment tokens in JSON.
use crate::{
    protocol::{decode, identifier},
    Error, Result,
};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;
const MAX_STATE: u64 = 65536;
const MAX_SECRET: u64 = 65536;

pub fn private_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Error::Storage);
    }
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(Error::Storage),
    }
    let meta = fs::symlink_metadata(path).map_err(|_| Error::Storage)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(Error::Storage);
    }
    fs::canonicalize(path).map_err(|_| Error::Storage)
}
fn check_file(file: &File) -> Result<()> {
    let meta = file.metadata().map_err(|_| Error::Storage)?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > MAX_STATE
    {
        return Err(Error::Storage);
    }
    Ok(())
}
fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    options
}
/// Exclusive lifetime lock is never unlinked (avoids locking a replaced inode).
pub struct Store {
    root: PathBuf,
    _lock: File,
}
impl Store {
    pub fn open(root: &Path) -> Result<Self> {
        let root = private_directory(root)?;
        let lock = options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("connector.lock"))
            .map_err(|_| Error::Storage)?;
        check_file(&lock)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error::Busy);
        }
        Ok(Self { root, _lock: lock })
    }
    pub fn read<T: DeserializeOwned>(&self) -> Result<Option<T>> {
        let file = match options().read(true).open(self.root.join("state.json")) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Storage),
        };
        check_file(&file)?;
        let mut bytes = Vec::new();
        file.take(MAX_STATE + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Storage)?;
        if bytes.len() as u64 > MAX_STATE {
            return Err(Error::Storage);
        }
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| Error::Storage)
    }
    pub fn write<T: Serialize>(&self, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() as u64 > MAX_STATE {
            return Err(Error::Storage);
        }
        // Check an existing target too: do not silently replace unsafe state.
        if let Ok(meta) = fs::symlink_metadata(self.root.join("state.json")) {
            if !meta.is_file() {
                return Err(Error::Storage);
            }
            let file = options()
                .read(true)
                .open(self.root.join("state.json"))
                .map_err(|_| Error::Storage)?;
            check_file(&file)?;
        }
        let temporary = self.root.join(format!(".state-{}", identifier()?));
        let result = (|| {
            let mut file = options()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| Error::Storage)?;
            file.write_all(&bytes).map_err(|_| Error::Storage)?;
            file.sync_all().map_err(|_| Error::Storage)?;
            fs::rename(&temporary, self.root.join("state.json")).map_err(|_| Error::Storage)?;
            File::open(&self.root)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| Error::Storage)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

/// Connector-owned credentials (identity key, registration token, APNs key)
/// in the same owner-only directory as the rest of the connector state.
///
/// macOS Keychain items created by a previous connector build are bound to
/// that binary's code requirement. The app updater replaces the sidecar, so
/// every update re-asked for the login-keychain password. These credentials
/// are machine-local and never leave the connector, so keeping them in 0600
/// files next to the state avoids that recurring system dialog. User-supplied
/// secrets elsewhere still use the platform credential store.
pub struct FileVault {
    directory: PathBuf,
}
impl FileVault {
    pub fn open(root: &Path) -> Result<Self> {
        let directory = private_directory(&private_directory(root)?.join("secrets"))?;
        Ok(Self { directory })
    }
    fn path(&self, account: &str) -> Result<PathBuf> {
        decode::<16>(account).map_err(|_| Error::Credential)?;
        Ok(self.directory.join(account))
    }
    pub(super) fn read(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let file = match options().read(true).open(self.path(account)?) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::Storage),
        };
        check_file(&file)?;
        let mut bytes = Zeroizing::new(Vec::new());
        file.take(MAX_SECRET + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::Storage)?;
        if bytes.is_empty() || bytes.len() as u64 > MAX_SECRET {
            return Err(Error::Storage);
        }
        Ok(Some(bytes))
    }
    pub(super) fn write_new(&self, account: &str, secret: &[u8]) -> Result<()> {
        if secret.is_empty() || secret.len() as u64 > MAX_SECRET {
            return Err(Error::Storage);
        }
        let target = self.path(account)?;
        if fs::symlink_metadata(&target).is_ok() {
            return Err(Error::Storage);
        }
        let temporary = self.directory.join(format!(".secret-{}", identifier()?));
        let result = (|| {
            let mut file = options()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|_| Error::Storage)?;
            file.write_all(secret).map_err(|_| Error::Storage)?;
            file.sync_all().map_err(|_| Error::Storage)?;
            fs::rename(&temporary, &target).map_err(|_| Error::Storage)?;
            File::open(&self.directory)
                .and_then(|dir| dir.sync_all())
                .map_err(|_| Error::Storage)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}
impl super::Vault for FileVault {
    fn load(&self, account: &str) -> Result<Zeroizing<Vec<u8>>> {
        self.read(account)?.ok_or(Error::Credential)
    }
    fn create(&self, secret: &[u8]) -> Result<String> {
        let account = identifier()?;
        self.write_new(&account, secret)?;
        if self.load(&account)?.as_slice() != secret {
            return Err(Error::Credential);
        }
        Ok(account)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connector::Vault;
    use std::os::unix::fs::{symlink, PermissionsExt};
    #[test]
    fn private_state_lock_links_permissions_and_atomic_roundtrip() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("connector");
        let store = Store::open(&root).unwrap();
        assert!(matches!(Store::open(&root), Err(Error::Busy)));
        store.write(&vec!["first"]).unwrap();
        store.write(&vec!["second"]).unwrap();
        assert_eq!(store.read::<Vec<String>>().unwrap().unwrap(), ["second"]);
        drop(store);
        let store = Store::open(&root).unwrap();
        fs::set_permissions(root.join("state.json"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(store.read::<Vec<String>>().is_err());
        assert!(store.write(&vec!["unsafe"]).is_err());
        fs::remove_file(root.join("state.json")).unwrap();
        let target = temp.path().join("sentinel");
        fs::write(&target, "unchanged").unwrap();
        symlink(&target, root.join("state.json")).unwrap();
        assert!(store.read::<Vec<String>>().is_err());
        assert!(store.write(&vec!["unsafe"]).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "unchanged");
        let linked_root = temp.path().join("linked");
        symlink(&root, &linked_root).unwrap();
        assert!(Store::open(&linked_root).is_err());
    }

    #[test]
    fn file_vault_roundtrips_owner_only_and_rejects_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("connector");
        let vault = FileVault::open(&root).unwrap();
        let account = vault.create(b"identity-key").unwrap();
        assert_eq!(vault.load(&account).unwrap().as_slice(), b"identity-key");
        let path = root.join("secrets").join(&account);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            FileVault::open(&root)
                .unwrap()
                .load(&account)
                .unwrap()
                .as_slice(),
            b"identity-key"
        );
        assert!(matches!(
            vault.load(&identifier().unwrap()),
            Err(Error::Credential)
        ));

        fs::remove_file(&path).unwrap();
        let sentinel = temp.path().join("sentinel");
        fs::write(&sentinel, "unchanged").unwrap();
        symlink(&sentinel, &path).unwrap();
        assert!(matches!(vault.load(&account), Err(Error::Storage)));
        assert_eq!(fs::read_to_string(sentinel).unwrap(), "unchanged");
    }

    #[test]
    fn file_vault_rejects_unsafe_roots_and_secrets() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("connector");
        let vault = FileVault::open(&root).unwrap();
        assert!(matches!(vault.create(b""), Err(Error::Storage)));
        assert!(matches!(
            vault.create(&vec![0u8; MAX_SECRET as usize + 1]),
            Err(Error::Storage)
        ));
        fs::set_permissions(root.join("secrets"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(FileVault::open(&root).is_err());
    }
}
