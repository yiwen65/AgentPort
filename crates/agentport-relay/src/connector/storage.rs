//! Connector-only local state. No private keys or deployment tokens in JSON.
use crate::{protocol::identifier, Error, Result};
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
const MAX_STATE: u64 = 65536;

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

#[cfg(test)]
mod tests {
    use super::*;
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
}
