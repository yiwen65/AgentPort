//! Application data paths. Everything lives under one app data dir; worktrees
//! live under `<data>/worktrees/<project-slug>/<task>` so the main checkout is
//! never polluted (PRD 1.4).

use crate::error::{CoreError, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct AppPaths {
    root: PathBuf,
}

impl AppPaths {
    /// Default: platform app-data dir (macOS `~/Library/Application Support/AgentPort`,
    /// Linux `~/.local/share/agentport`). Honors `AGENTPORT_DATA_DIR` for tests/CI.
    pub fn default() -> Result<Self> {
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
        AppPaths { root }
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
            self.diagnostics_dir(),
        ] {
            std::fs::create_dir_all(&d)?;
        }
        // Socket dir must be private.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(self.socket_dir(), std::fs::Permissions::from_mode(0o700))?;
        }
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
