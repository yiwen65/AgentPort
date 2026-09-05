use crate::{public_key_fingerprint, random_id, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::Serialize;
#[cfg(unix)]
use std::os::{
    fd::AsRawFd,
    unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};
const MARKER: &str = "agentport-mobile:";
const MAX_KEYS_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    pub id: String,
    pub name: String,
    pub fingerprint: String,
}

#[cfg(unix)]
fn check_directory(directory: &Path, create: bool) -> Result<bool> {
    if !directory.exists() && !directory.is_symlink() {
        if !create {
            return Ok(false);
        }
        fs::create_dir(directory).map_err(|_| "Cannot create SSH directory")?;
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot secure SSH directory")?;
    }
    let metadata = fs::symlink_metadata(directory).map_err(|_| "Cannot inspect SSH directory")?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err(
            "SSH directory must be owned by this user, not a symlink or writable by others".into(),
        );
    }
    Ok(true)
}
#[cfg(unix)]
fn read_keys(path: &Path) -> Result<Vec<u8>> {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Cannot safely open authorized_keys".into()),
    };
    let metadata = file
        .metadata()
        .map_err(|_| "Cannot inspect authorized_keys")?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
        || metadata.len() > MAX_KEYS_BYTES
    {
        return Err("Unsafe authorized_keys ownership, permissions, links or size".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_KEYS_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read authorized_keys")?;
    if bytes.len() as u64 > MAX_KEYS_BYTES {
        return Err("authorized_keys is too large".into());
    }
    Ok(bytes)
}
fn device_from_line(line: &str) -> Option<PairedDevice> {
    let marker = line.split_whitespace().last()?.strip_prefix(MARKER)?;
    let (id, name) = marker.split_once(':')?;
    if id.len() != 22
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return None;
    }
    let key_start = line.rfind("ssh-ed25519 ")?;
    let key = line[key_start..]
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    Some(PairedDevice {
        id: id.into(),
        name: String::from_utf8(URL_SAFE_NO_PAD.decode(name).ok()?).ok()?,
        fingerprint: public_key_fingerprint(&key).ok()?,
    })
}
#[cfg(unix)]
pub fn devices(directory: &Path) -> Result<Vec<PairedDevice>> {
    if !check_directory(directory, false)? {
        return Ok(Vec::new());
    }
    let bytes = read_keys(&directory.join("authorized_keys"))?;
    let text = std::str::from_utf8(&bytes).map_err(|_| "authorized_keys must be UTF-8")?;
    Ok(text.lines().filter_map(device_from_line).collect())
}

#[cfg(unix)]
fn update(directory: &Path, transform: impl FnOnce(&str) -> Result<String>) -> Result<()> {
    check_directory(directory, true)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(directory.join(".agentport-mobile-keys.lock"))
        .map_err(|_| "Cannot open SSH authorization lock")?;
    let metadata = lock
        .metadata()
        .map_err(|_| "Cannot inspect SSH authorization lock")?;
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err("Unsafe SSH authorization lock".into());
    }
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("SSH authorization is busy; try again".into());
    }
    let path = directory.join("authorized_keys");
    let before = read_keys(&path)?;
    let after =
        transform(std::str::from_utf8(&before).map_err(|_| "authorized_keys must be UTF-8")?)?;
    if after.len() as u64 > MAX_KEYS_BYTES {
        return Err("authorized_keys is too large".into());
    }
    let temporary = directory.join(format!(".agentport-keys-{}", random_id()?));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&temporary)
            .map_err(|_| "Cannot stage SSH authorization")?;
        file.write_all(after.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot persist SSH authorization")?;
        // Serialize this app's writers and detect edits made by external tools
        // during preparation. Never rewrite an unrecognized concurrent version.
        if read_keys(&path)? != before {
            return Err("authorized_keys changed concurrently; try again".into());
        }
        fs::rename(&temporary, &path).map_err(|_| "Cannot replace SSH authorization")?;
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|_| "Cannot sync SSH authorization")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(unix)]
pub fn authorize(
    directory: &Path,
    id: &str,
    name: &str,
    key: &str,
    bridge: &Path,
) -> Result<PairedDevice> {
    let fingerprint = public_key_fingerprint(key)?;
    if id.len() != 22
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || name.len() > 80
        || name.chars().any(char::is_control)
    {
        return Err("Invalid device identity".into());
    }
    let bridge = bridge
        .to_str()
        .filter(|value| {
            value.starts_with('/') && !value.contains(['\n', '\r', '"', '\\', '\'', '`', '$'])
        })
        .ok_or("Unsafe Bridge executable path")?;
    // The single-quoted executable protects paths with spaces from the remote
    // shell. restrict disables port/agent/X11 forwarding and PTY allocation.
    let line = format!(
        "restrict,command=\"'{bridge}' serve --stdio\" {key} {MARKER}{id}:{}",
        URL_SAFE_NO_PAD.encode(name)
    );
    update(directory, |before| {
        if before
            .lines()
            .filter_map(device_from_line)
            .any(|device| device.id == id || device.fingerprint == fingerprint)
        {
            return Err("Device was already authorized".into());
        }
        let separator = if before.is_empty() || before.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        Ok(format!("{before}{separator}{line}\n"))
    })?;
    Ok(PairedDevice {
        id: id.into(),
        name: name.into(),
        fingerprint,
    })
}
#[cfg(unix)]
pub fn revoke(directory: &Path, id: &str, fingerprint: &str) -> Result<()> {
    update(directory, |before| {
        let mut removed = false;
        let after = before
            .split_inclusive('\n')
            .filter(|line| {
                let matching = device_from_line(line)
                    .is_some_and(|device| device.id == id && device.fingerprint == fingerprint);
                removed |= matching;
                !matching
            })
            .collect::<String>();
        if !removed {
            return Err("Paired device changed or is no longer present".into());
        }
        Ok(after)
    })
}
#[cfg(not(unix))]
pub fn devices(_: &Path) -> Result<Vec<PairedDevice>> {
    Err("SSH pairing is supported on macOS".into())
}
#[cfg(not(unix))]
pub fn authorize(_: &Path, _: &str, _: &str, _: &str, _: &Path) -> Result<PairedDevice> {
    Err("SSH pairing is supported on macOS".into())
}
#[cfg(not(unix))]
pub fn revoke(_: &Path, _: &str, _: &str) -> Result<()> {
    Err("SSH pairing is supported on macOS".into())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn approval_and_revocation_preserve_other_keys_byte_for_byte() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("ssh");
        fs::create_dir(&directory).unwrap();
        let old = "# user keys\nssh-rsa existing-key other-device\n";
        fs::write(directory.join("authorized_keys"), old).unwrap();
        let id = random_id().unwrap();
        let device = authorize(
            &directory,
            &id,
            "Test Phone",
            &crate::tests::key(),
            Path::new("/Applications/AgentPort.app/Contents/MacOS/agentport-remote-bridge"),
        )
        .unwrap();
        assert_eq!(devices(&directory).unwrap()[0].name, "Test Phone");
        assert!(authorize(
            &directory,
            &id,
            "Test Phone",
            &crate::tests::key(),
            Path::new("/bridge")
        )
        .is_err());
        assert!(revoke(&directory, &id, "wrong-fingerprint").is_err());
        revoke(&directory, &id, &device.fingerprint).unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("authorized_keys")).unwrap(),
            old
        );
    }
    #[test]
    fn refuses_symlink_targets_without_touching_the_destination() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("ssh");
        fs::create_dir(&directory).unwrap();
        let destination = temp.path().join("untouched");
        fs::write(&destination, "unchanged").unwrap();
        std::os::unix::fs::symlink(&destination, directory.join("authorized_keys")).unwrap();
        assert!(authorize(
            &directory,
            &random_id().unwrap(),
            "Phone",
            &crate::tests::key(),
            Path::new("/bridge")
        )
        .is_err());
        assert_eq!(fs::read_to_string(destination).unwrap(), "unchanged");
    }
    #[test]
    fn refuses_hardlinked_lock_and_duplicate_key_without_rewriting_other_keys() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("ssh");
        fs::create_dir(&directory).unwrap();
        let id = random_id().unwrap();
        authorize(
            &directory,
            &id,
            "Phone",
            &crate::tests::key(),
            Path::new("/bridge"),
        )
        .unwrap();
        let before = fs::read(directory.join("authorized_keys")).unwrap();
        assert!(authorize(
            &directory,
            &random_id().unwrap(),
            "Other",
            &crate::tests::key(),
            Path::new("/bridge")
        )
        .is_err());
        fs::hard_link(
            directory.join(".agentport-mobile-keys.lock"),
            temp.path().join("lock-link"),
        )
        .unwrap();
        assert!(revoke(
            &directory,
            &id,
            &public_key_fingerprint(&crate::tests::key()).unwrap()
        )
        .is_err());
        assert_eq!(fs::read(directory.join("authorized_keys")).unwrap(), before);
    }
}
