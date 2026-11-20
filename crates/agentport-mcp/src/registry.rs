//! Ownership registry for Sessions created through this MCP.
//!
//! The registry is a small JSON file in the AgentPort data directory rather
//! than a database table: ownership only constrains what this server may drive,
//! and keeping it out of the schema avoids a migration coupled to the app
//! version. Losing the file degrades to "everything is user-owned", which is
//! the safe direction.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const MCP_DIR: &str = "mcp";
const REGISTRY_FILE: &str = "agent-sessions.json";
const LOCK_FILE: &str = "agent-sessions.lock";
/// Two MCP servers can run at once (one per agent window). Writers take this
/// lock, re-read the file, merge and rename, so neither loses the other's rows.
const LOCK_WAIT: Duration = Duration::from_millis(1500);
const LOCK_STALE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OwnedSession {
    pub session_id: String,
    pub created_at: String,
    /// Delegation depth of the Session this MCP created.
    pub depth: u32,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// Permission mode the delegated Session was launched with, for audit.
    #[serde(default)]
    pub permission: Option<String>,
}

#[derive(Debug, Default)]
pub struct Registry {
    dir: PathBuf,
    entries: BTreeMap<String, OwnedSession>,
}

impl Registry {
    pub fn load(root: &Path) -> Registry {
        let dir = root.join(MCP_DIR);
        let path = dir.join(REGISTRY_FILE);
        let (entries, corrupt) = read_entries(&path);
        if corrupt {
            // Never overwrite evidence of a corrupt registry silently; the
            // caller-visible behaviour is simply "nothing owned".
            let backup = path.with_extension(format!("corrupt-{}", std::process::id()));
            let _ = fs::rename(&path, &backup);
            eprintln!(
                "agentport-mcp: ownership registry unreadable; moved to {}",
                backup.display()
            );
        }
        Registry { dir, entries }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.entries.contains_key(session_id)
    }

    pub fn get(&self, session_id: &str) -> Option<&OwnedSession> {
        self.entries.get(session_id)
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn insert(&mut self, entry: OwnedSession) -> io::Result<()> {
        let id = entry.session_id.clone();
        self.mutate(|entries| {
            entries.insert(id, entry);
        })
    }

    pub fn remove(&mut self, session_id: &str) -> io::Result<()> {
        if !self.entries.contains_key(session_id) {
            return Ok(());
        }
        let id = session_id.to_string();
        self.mutate(|entries| {
            entries.remove(&id);
        })
    }

    /// Drop entries whose Session no longer exists or has finished.
    pub fn prune(&mut self, keep: &std::collections::HashSet<String>) {
        let stale: Vec<String> = self
            .entries
            .keys()
            .filter(|id| !keep.contains(*id))
            .cloned()
            .collect();
        if stale.is_empty() {
            return;
        }
        let _ = self.mutate(|entries| {
            for id in &stale {
                entries.remove(id);
            }
        });
    }

    /// Read-modify-write under an exclusive lock, re-reading first so a second
    /// server's rows are merged rather than overwritten.
    fn mutate<F>(&mut self, apply: F) -> io::Result<()>
    where
        F: FnOnce(&mut BTreeMap<String, OwnedSession>),
    {
        fs::create_dir_all(&self.dir)?;
        let _guard = FileLock::acquire(&self.dir.join(LOCK_FILE))?;
        let mut entries = read_entries(&self.dir.join(REGISTRY_FILE)).0;
        apply(&mut entries);
        write_entries(&self.dir, &entries)?;
        self.entries = entries;
        Ok(())
    }
}

fn read_entries(path: &Path) -> (BTreeMap<String, OwnedSession>, bool) {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<Vec<OwnedSession>>(&bytes) {
            Ok(entries) => (
                entries
                    .into_iter()
                    .map(|entry| (entry.session_id.clone(), entry))
                    .collect(),
                false,
            ),
            Err(_) => (BTreeMap::new(), true),
        },
        Err(_) => (BTreeMap::new(), false),
    }
}

fn write_entries(dir: &Path, entries: &BTreeMap<String, OwnedSession>) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(REGISTRY_FILE);
    let values: Vec<&OwnedSession> = entries.values().collect();
    let body = serde_json::to_vec_pretty(&values)?;
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        io::Write::write_all(&mut file, &body)?;
        file.sync_all()?;
    }
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(&tmp, &path)
}

/// Exclusive-create lock file with a staleness escape hatch: a crashed writer
/// must not wedge every later MCP process.
struct FileLock {
    path: PathBuf,
}

impl FileLock {
    fn acquire(path: &Path) -> io::Result<FileLock> {
        let deadline = SystemTime::now() + LOCK_WAIT;
        loop {
            match fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)
            {
                Ok(_) => return Ok(FileLock { path: path.to_path_buf() }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if let Ok(metadata) = fs::metadata(path) {
                        if let Ok(modified) = metadata.modified() {
                            if SystemTime::now()
                                .duration_since(modified)
                                .map(|age| age > LOCK_STALE)
                                .unwrap_or(false)
                            {
                                let _ = fs::remove_file(path);
                                continue;
                            }
                        }
                    }
                    if SystemTime::now() > deadline {
                        // Proceed unlocked rather than failing the tool: a lost
                        // row is recoverable (the Session still exists), a
                        // failed delegation is not.
                        return Ok(FileLock { path: PathBuf::new() });
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        }
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, depth: u32) -> OwnedSession {
        OwnedSession {
            session_id: id.into(),
            created_at: "2026-11-20T00:00:00Z".into(),
            depth,
            parent_session_id: None,
            agent: Some("shell".into()),
            title: None,
            permission: Some("bypass".into()),
        }
    }

    #[test]
    fn registry_round_trips_and_scopes_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = Registry::load(dir.path());
        assert!(!registry.contains("ses_1"));
        registry.insert(entry("ses_1", 1)).unwrap();

        let reloaded = Registry::load(dir.path());
        assert!(reloaded.contains("ses_1"));
        assert_eq!(reloaded.get("ses_1").unwrap().depth, 1);

        let mut registry = reloaded;
        registry.remove("ses_1").unwrap();
        assert!(!Registry::load(dir.path()).contains("ses_1"));
    }

    #[test]
    fn corrupt_registry_falls_back_to_empty_and_is_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(MCP_DIR).join(REGISTRY_FILE);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();

        let registry = Registry::load(dir.path());
        assert_eq!(registry.len(), 0);
        assert!(!path.exists());
    }

    #[test]
    fn two_servers_merge_instead_of_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let mut first = Registry::load(dir.path());
        let mut second = Registry::load(dir.path());
        first.insert(entry("ses_a", 0)).unwrap();
        // `second` loaded before `ses_a` existed; its write must not erase it.
        second.insert(entry("ses_b", 0)).unwrap();
        let merged = Registry::load(dir.path());
        assert!(merged.contains("ses_a"));
        assert!(merged.contains("ses_b"));
    }

    #[test]
    fn prune_drops_sessions_that_are_gone() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = Registry::load(dir.path());
        registry.insert(entry("ses_live", 0)).unwrap();
        registry.insert(entry("ses_dead", 0)).unwrap();
        let keep: std::collections::HashSet<String> =
            ["ses_live".to_string()].into_iter().collect();
        registry.prune(&keep);
        let reloaded = Registry::load(dir.path());
        assert!(reloaded.contains("ses_live"));
        assert!(!reloaded.contains("ses_dead"));
    }

    #[test]
    fn registry_file_is_private() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = Registry::load(dir.path());
        registry.insert(entry("ses_1", 0)).unwrap();
        let mode = fs::metadata(dir.path().join(MCP_DIR).join(REGISTRY_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
