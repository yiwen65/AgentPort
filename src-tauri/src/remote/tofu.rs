//! Trust-on-first-use host key store for SSH device connections.
//!
//! Persisted as JSON with 0600 permissions at `<data-root>/devices/
//! known-hosts.json`. A first contact records the server key (after the
//! authentication handshake succeeds); a later mismatch is a hard failure
//! with the distinct `host_key_changed` code so the user can re-verify the
//! device out of band instead of silently accepting a different machine.

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;

use russh::keys::{HashAlg, PublicKey};
use serde::{Deserialize, Serialize};

use crate::remote::RemoteCommandError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TofuEntry {
    pub algorithm: String,
    /// OpenSSH-style `SHA256:<base64>` fingerprint of the server public key.
    pub fingerprint: String,
    /// OpenSSH single-line public key, kept for out-of-band comparison.
    pub public_key_openssh: String,
    pub trusted_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TofuDecision {
    /// Known host, presented key matches the stored entry.
    Match,
    /// Unknown host: caller proceeds and commits `entry` after auth succeeds.
    NewHost(TofuEntry),
}

#[derive(Debug)]
pub struct TofuStore {
    path: PathBuf,
    entries: BTreeMap<String, TofuEntry>,
}

impl TofuStore {
    pub fn load(path: PathBuf) -> Result<Self, RemoteCommandError> {
        let entries = match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str(&raw).map_err(|error| {
                RemoteCommandError::new(
                    "tofu_store_corrupt",
                    format!(
                        "known-hosts store at {} is not valid JSON: {error}",
                        path.display()
                    ),
                )
            })?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => {
                return Err(RemoteCommandError::new(
                    "tofu_store_unreadable",
                    format!("cannot read {}: {error}", path.display()),
                ))
            }
        };
        Ok(Self { path, entries })
    }

    fn key_id(host: &str, port: u16) -> String {
        format!("{host}:{port}")
    }

    fn describe(key: &PublicKey) -> Result<TofuEntry, RemoteCommandError> {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let public_key_openssh = key.to_openssh().map_err(|error| {
            RemoteCommandError::new(
                "host_key_unusable",
                format!("cannot encode host key: {error}"),
            )
        })?;
        Ok(TofuEntry {
            algorithm: key.algorithm().to_string(),
            fingerprint,
            public_key_openssh,
            // Filled by `commit` so a rejected key never gets a timestamp.
            trusted_at: String::new(),
        })
    }

    /// Compares the presented key against the store.
    pub fn check(
        &self,
        host: &str,
        port: u16,
        key: &PublicKey,
    ) -> Result<TofuDecision, RemoteCommandError> {
        let id = Self::key_id(host, port);
        let entry = Self::describe(key)?;
        match self.entries.get(&id) {
            Some(stored) if stored.fingerprint == entry.fingerprint => Ok(TofuDecision::Match),
            Some(stored) => Err(RemoteCommandError::new(
                "host_key_changed",
                format!(
                    "host key for {id} changed: was {} ({}), now {} ({})",
                    stored.fingerprint, stored.algorithm, entry.fingerprint, entry.algorithm
                ),
            )),
            None => Ok(TofuDecision::NewHost(entry)),
        }
    }

    /// Persists a first-use entry. Never downgrades an existing record.
    pub fn commit(
        &mut self,
        host: &str,
        port: u16,
        mut entry: TofuEntry,
    ) -> Result<(), RemoteCommandError> {
        let id = Self::key_id(host, port);
        if self.entries.contains_key(&id) {
            return Ok(());
        }
        entry.trusted_at = chrono::Utc::now().to_rfc3339();
        self.entries.insert(id, entry);
        self.save()
    }

    fn save(&self) -> Result<(), RemoteCommandError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                RemoteCommandError::new(
                    "tofu_store_unwritable",
                    format!("cannot create {}: {error}", parent.display()),
                )
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
            }
        }
        let json = serde_json::to_vec_pretty(&self.entries).map_err(|error| {
            RemoteCommandError::new(
                "tofu_store_corrupt",
                format!("cannot encode store: {error}"),
            )
        })?;
        let tmp = self.path.with_extension("json.tmp");
        {
            let mut file = fs::File::create(&tmp).map_err(|error| {
                RemoteCommandError::new(
                    "tofu_store_unwritable",
                    format!("cannot write {}: {error}", tmp.display()),
                )
            })?;
            file.write_all(&json)
                .and_then(|_| file.sync_all())
                .map_err(|error| {
                    RemoteCommandError::new(
                        "tofu_store_unwritable",
                        format!("cannot write {}: {error}", tmp.display()),
                    )
                })?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &self.path).map_err(|error| {
            RemoteCommandError::new(
                "tofu_store_unwritable",
                format!("cannot replace {}: {error}", self.path.display()),
            )
        })
    }

    #[cfg(test)]
    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (tempfile::TempDir, TofuStore) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices").join("known-hosts.json");
        (dir, TofuStore::load(path).unwrap())
    }

    /// Fixed throwaway ed25519 public keys generated with `ssh-keygen` for
    /// these tests (private halves are not used anywhere).
    const SAMPLE_KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINc8fmaD1xnWATW4px/aiIUBeE9AKobwcOYCCLkhHM6f agentport-tofu-test-a";
    const SAMPLE_KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJA1SSVZzK0aqlgwoHJZfqEoXnJbfFSFA7xJBASHlH1b agentport-tofu-test-b";

    fn parse_key(openssh: &str) -> PublicKey {
        PublicKey::from_openssh(openssh).unwrap()
    }

    #[test]
    fn first_use_records_then_matches() {
        let (_dir, mut store) = temp_store();
        let key = parse_key(SAMPLE_KEY_A);
        let decision = store.check("example.lan", 22, &key).unwrap();
        let TofuDecision::NewHost(entry) = decision else {
            panic!("first contact must be NewHost");
        };
        store.commit("example.lan", 22, entry).unwrap();
        assert!(matches!(
            store.check("example.lan", 22, &key).unwrap(),
            TofuDecision::Match
        ));
    }

    #[test]
    fn changed_key_is_rejected_with_distinct_code() {
        let (_dir, mut store) = temp_store();
        let first = parse_key(SAMPLE_KEY_A);
        let TofuDecision::NewHost(entry) = store.check("example.lan", 22, &first).unwrap() else {
            panic!("expected NewHost");
        };
        store.commit("example.lan", 22, entry).unwrap();
        let other = parse_key(SAMPLE_KEY_B);
        let error = store.check("example.lan", 22, &other).unwrap_err();
        assert_eq!(error.code, "host_key_changed");
    }

    #[test]
    fn store_is_scoped_per_host_and_port() {
        let (_dir, mut store) = temp_store();
        let key = parse_key(SAMPLE_KEY_A);
        let TofuDecision::NewHost(entry) = store.check("example.lan", 22, &key).unwrap() else {
            panic!("expected NewHost");
        };
        store.commit("example.lan", 22, entry).unwrap();
        assert!(matches!(
            store.check("example.lan", 2222, &key).unwrap(),
            TofuDecision::NewHost(_)
        ));
    }

    #[test]
    fn persisted_file_has_owner_only_permissions() {
        let (_dir, mut store) = temp_store();
        let key = parse_key(SAMPLE_KEY_A);
        let TofuDecision::NewHost(entry) = store.check("example.lan", 22, &key).unwrap() else {
            panic!("expected NewHost");
        };
        store.commit("example.lan", 22, entry).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "known-hosts.json must be 0600");
        }
        // Reload round-trips the entry.
        let reloaded = TofuStore::load(store.path().to_path_buf()).unwrap();
        assert!(matches!(
            reloaded.check("example.lan", 22, &key).unwrap(),
            TofuDecision::Match
        ));
    }

    #[test]
    fn corrupt_store_is_a_structured_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known-hosts.json");
        fs::write(&path, b"not json").unwrap();
        let error = TofuStore::load(path).unwrap_err();
        assert_eq!(error.code, "tofu_store_corrupt");
    }
}
