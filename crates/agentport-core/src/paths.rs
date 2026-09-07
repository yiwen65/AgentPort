//! Application data paths. Everything lives under one app data dir; worktrees
//! live under `<data>/worktrees/<project-slug>/<task>` so the main checkout is
//! never polluted (PRD 1.4).

use crate::error::{CoreError, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppPaths {
    root: PathBuf,
    pi_sessions_root: Option<PathBuf>,
}

impl AppPaths {
    /// Default: platform app-data dir (macOS `~/Library/Application Support/AgentPort`,
    /// Linux `~/.local/share/agentport`). Honors `AGENTPORT_DATA_DIR` for tests/CI.
    pub fn discover() -> Result<Self> {
        if let Ok(p) = std::env::var("AGENTPORT_DATA_DIR") {
            return Ok(Self::new(PathBuf::from(p)));
        }
        let base = dirs::data_dir().ok_or_else(|| CoreError::Internal("no data dir".into()))?;
        // macOS convention: ~/Library/Application Support/AgentPort
        // Linux/PRD convention: ~/.local/share/agentport
        let leaf = if cfg!(target_os = "macos") {
            "AgentPort"
        } else {
            "agentport"
        };
        Ok(Self::new(base.join(leaf)))
    }

    pub fn new(root: PathBuf) -> Self {
        AppPaths {
            root,
            pi_sessions_root: None,
        }
    }

    /// Explicit embedding/test override. Never derives provider storage from the app data root.
    pub fn with_pi_sessions_root(mut self, root: PathBuf) -> Self {
        self.pi_sessions_root = Some(root);
        self
    }

    pub fn pi_sessions_root(&self) -> Result<PathBuf> {
        let root = if let Some(root) = &self.pi_sessions_root {
            root.clone()
        } else if let Some(agent_dir) = std::env::var_os("EASY_PI_CODING_AGENT_DIR") {
            PathBuf::from(agent_dir).join("sessions")
        } else {
            dirs::home_dir()
                .ok_or_else(|| CoreError::Internal("no home directory".into()))?
                .join(".epi/agent/sessions")
        };
        if !root.is_absolute() {
            return Err(CoreError::Validation(
                "easy-pi sessions directory must be absolute".into(),
            ));
        }
        Ok(root)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn db_path(&self) -> PathBuf {
        self.root.join("agentport.db")
    }
    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }
    pub fn session_dir(&self, session_id: &str) -> PathBuf {
        self.sessions_dir().join(session_id)
    }
    pub fn log_path(&self, session_id: &str) -> PathBuf {
        self.session_dir(session_id).join("output.log")
    }
    /// Output is scoped to a concrete Host launch. Keeping each run in its
    /// own directory prevents a restarted Host from assigning a new run ID to
    /// bytes that belonged to the previous launch.
    pub fn run_dir(&self, session_id: &str, run_id: &str) -> PathBuf {
        self.session_dir(session_id).join("runs").join(run_id)
    }
    pub fn run_log_path(&self, session_id: &str, run_id: &str) -> PathBuf {
        self.run_dir(session_id, run_id).join("output.log")
    }
    /// Host config passed to the host process (no secrets — PRD 3.7).
    pub fn host_config_path(&self, session_id: &str) -> PathBuf {
        self.session_dir(session_id).join("host.json")
    }
    /// File the CLI hooks append events to (JSON lines).
    pub fn hook_events_path(&self, session_id: &str) -> PathBuf {
        self.session_dir(session_id).join("events.jsonl")
    }
    pub fn socket_dir(&self) -> PathBuf {
        // Short paths — Unix socket paths are limited (~104 chars on macOS).
        if let Ok(p) = std::env::var("AGENTPORT_SOCKET_DIR") {
            return PathBuf::from(p);
        }
        std::env::temp_dir().join(format!("agentport-{}", unsafe { libc::getuid() }))
    }
    pub fn socket_path(&self, session_id: &str) -> PathBuf {
        self.socket_dir().join(format!("{session_id}.sock"))
    }
    pub fn worktrees_root(&self) -> PathBuf {
        self.root.join("worktrees")
    }
    pub fn worktree_dir(&self, project_slug: &str, task_slug: &str) -> PathBuf {
        self.worktrees_root().join(project_slug).join(task_slug)
    }
    pub fn exports_dir(&self) -> PathBuf {
        self.root.join("exports")
    }
    /// Full-data backup archives created from the settings page / CLI default.
    /// Excluded from backup payloads (backing up backups would recurse).
    pub fn backups_dir(&self) -> PathBuf {
        self.root.join("backups")
    }
    pub fn diagnostics_dir(&self) -> PathBuf {
        self.root.join("diagnostics")
    }
    pub fn host_log_path(&self, session_id: &str) -> PathBuf {
        self.session_dir(session_id).join("host.log")
    }

    pub fn ensure_layout(&self) -> Result<()> {
        for d in [
            self.root.clone(),
            self.sessions_dir(),
            self.socket_dir(),
            self.worktrees_root(),
            self.exports_dir(),
            self.backups_dir(),
            self.diagnostics_dir(),
        ] {
            std::fs::create_dir_all(&d)?;
        }
        // Session metadata, terminal logs and exports may contain sensitive
        // source content, and the DB holds live Host tokens. Keep every
        // persistent directory owner-only, including on upgrades from older
        // installs that predate this hardening.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for d in [
                self.root.clone(),
                self.sessions_dir(),
                self.socket_dir(),
                self.worktrees_root(),
                self.exports_dir(),
                self.backups_dir(),
                self.diagnostics_dir(),
            ] {
                std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        Ok(())
    }

    /// Restrict one already-existing file to owner-only access. Missing files
    /// are skipped (e.g. the WAL sidecars before the first write).
    #[cfg(unix)]
    pub fn restrict_file(path: &std::path::Path) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(path) {
            Ok(_) => {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(CoreError::Io(e)),
        }
    }

    #[cfg(not(unix))]
    pub fn restrict_file(_path: &std::path::Path) -> Result<()> {
        Ok(())
    }
}

/// Slugify a user-visible name into a filesystem/branch-safe token.
pub fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "task".into()
    } else {
        out.chars().take(60).collect()
    }
}

/// Normalize to an absolute, symlink-resolved path string. Must exist.
pub fn normalize_abs(p: &str) -> Result<String> {
    let path = Path::new(p);
    let canon = std::fs::canonicalize(path)
        .map_err(|e| CoreError::Validation(format!("cannot resolve path {p}: {e}")))?;
    if !canon.is_dir() {
        return Err(CoreError::Validation(format!("not a directory: {p}")));
    }
    Ok(canon.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Fix login timeout!"), "fix-login-timeout");
        assert_eq!(slugify("  中文 标题 x"), "x");
        assert_eq!(slugify("a--b__c"), "a-b-c");
    }
}
