//! Periodic adapter discovery on the remote side.
//!
//! The interactive bridge request loop and terminal I/O share one connection;
//! running agent probes there stalls input for seconds. This module probes on
//! a dedicated background thread and writes the results to the shared Host DB,
//! so desktop clients can keep reading the cheap `agent.supported` cache.

use agentport_remote_protocol::AgentProbeAllParams;
use agentport_service::RemoteService;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
const CHECK_INTERVAL: Duration = Duration::from_secs(60);
const REFRESHED_AT_FILE: &str = "adapter-cache-refreshed-at";
const LOCK_FILE: &str = "adapter-cache-refresh.lock";

/// Start the periodic refresh. The thread owns no connection state; it only
/// shares the Host service and its database.
pub fn spawn<S>(service: Arc<S>, root: PathBuf)
where
    S: RemoteService + Send + Sync + 'static,
{
    let _ = thread::Builder::new()
        .name("adapter-cache-refresh".into())
        .spawn(move || loop {
            if refresh_due(&root, SystemTime::now()) {
                if let Some(_lock) = try_lock(&root) {
                    // Another bridge may have refreshed while we waited for
                    // the lock; re-check before spending CPU on a probe.
                    if refresh_due(&root, SystemTime::now()) {
                        match service.probe_all_agents(AgentProbeAllParams {
                            preserve_selections: true,
                        }) {
                            Ok(_) => {
                                if let Err(error) = write_refreshed_at(&root, SystemTime::now()) {
                                    eprintln!(
                                        "agentport remote bridge: adapter refresh timestamp failed: {error}"
                                    );
                                }
                            }
                            Err(error) => eprintln!(
                                "agentport remote bridge: adapter refresh failed: {error}"
                            ),
                        }
                    }
                }
            }
            thread::sleep(CHECK_INTERVAL);
        });
}

fn refresh_due(root: &Path, now: SystemTime) -> bool {
    let Ok(raw) = fs::read_to_string(root.join(REFRESHED_AT_FILE)) else {
        return true;
    };
    let Ok(previous) = raw.trim().parse::<u64>() else {
        return true;
    };
    let Ok(now) = now.duration_since(UNIX_EPOCH) else {
        return true;
    };
    if now.as_secs() < previous {
        // Clock moved backwards: refresh rather than wait out a future stamp.
        return true;
    }
    now.as_secs() - previous >= REFRESH_INTERVAL.as_secs()
}

fn write_refreshed_at(root: &Path, now: SystemTime) -> std::io::Result<()> {
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map_err(std::io::Error::other)?
        .as_secs();
    let target = root.join(REFRESHED_AT_FILE);
    let temporary = root.join(format!(
        ".{REFRESHED_AT_FILE}.tmp-{}",
        std::process::id()
    ));
    fs::write(&temporary, seconds.to_string())?;
    fs::rename(&temporary, &target)
}

#[cfg(unix)]
fn try_lock(root: &Path) -> Option<File> {
    use std::os::unix::io::AsRawFd;
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(root.join(LOCK_FILE))
        .ok()?;
    // Advisory lock; released automatically when this process exits.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    (result == 0).then_some(file)
}

#[cfg(not(unix))]
fn try_lock(root: &Path) -> Option<File> {
    // Remote Hosts are Unix today. Keep the refresher functional elsewhere
    // without a cross-process lock.
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(root.join(LOCK_FILE))
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn temp_root() -> PathBuf {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "agentport-adapter-cache-test-{}-{id}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn refresh_is_due_without_a_timestamp() {
        let root = temp_root();
        assert!(refresh_due(&root, SystemTime::now()));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refresh_is_not_due_immediately_after_writing() {
        let root = temp_root();
        let now = SystemTime::now();
        write_refreshed_at(&root, now).unwrap();
        assert!(!refresh_due(&root, now));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refresh_is_due_after_the_interval() {
        let root = temp_root();
        let now = SystemTime::now();
        let old = now - REFRESH_INTERVAL - Duration::from_secs(1);
        write_refreshed_at(&root, old).unwrap();
        assert!(refresh_due(&root, now));
        fs::remove_dir_all(root).unwrap();
    }
}
