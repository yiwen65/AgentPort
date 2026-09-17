//! Diagnostics center support (PRD 2, 3.6): host list, CLI capability view,
//! copyable diagnostic summary. Values shown here must already be redacted —
//! this module never touches secret values.

use crate::db::Db;
use crate::error::Result;
use crate::host_manager::HostManager;
use crate::paths::AppPaths;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub session_id: String,
    pub title: String,
    pub host_pid: Option<i64>,
    pub alive: bool,
    pub socket_path: Option<String>,
    pub log_bytes: u64,
    pub lifecycle: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,              // "macos" | "linux"
    pub os_version: String,      // e.g. "26.5.1" / "Ubuntu 24.04" best-effort
    pub arch: String,            // "arm64" | "x86_64"
    pub webview: Option<String>, // filled by GUI layer (WKWebView/WebKitGTK version)
    pub app_version: String,
}

pub struct Diagnostics<'a> {
    pub paths: &'a AppPaths,
    pub db: &'a Db,
}

impl<'a> Diagnostics<'a> {
    /// Per-session host liveness (socket handshake where marked running).
    pub fn host_list(&self) -> Result<Vec<HostInfo>> {
        let hosts = HostManager {
            paths: self.paths,
            db: self.db,
        };
        let mut out = Vec::new();
        for s in self.db.list_sessions(None, false)? {
            // Lightweight handshake; is_alive short-circuits when no socket is
            // recorded and connect() fails fast on a stale/dead socket path.
            let alive = hosts.is_alive(&s.id);
            // The Host keeps no PTY body copy (docs/user-guide.md, "不保存正文索引"),
            // so count what this run actually emitted instead of stat-ing a file
            // that is never written.
            let log_bytes = self
                .db
                .get_latest_log_cursor(&s.id)
                .ok()
                .flatten()
                .map(|cursor| u64::try_from(cursor.offset).unwrap_or(0))
                .unwrap_or(0);
            out.push(HostInfo {
                session_id: s.id,
                title: s.title,
                host_pid: s.host_pid,
                alive,
                socket_path: s.host_socket,
                log_bytes,
                lifecycle: s.lifecycle.as_str().to_string(),
            });
        }
        Ok(out)
    }

    pub fn platform_info(&self) -> PlatformInfo {
        let os = if cfg!(target_os = "macos") {
            "macos".to_string()
        } else if cfg!(target_os = "linux") {
            "linux".to_string()
        } else {
            std::env::consts::OS.to_string()
        };
        PlatformInfo {
            os,
            os_version: os_version(),
            arch: std::env::consts::ARCH.to_string(),
            webview: None, // filled by the GUI layer
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }

    /// One-paragraph copyable summary: versions, adapter capabilities, recent
    /// status, redaction hit counts. No paths containing secrets, no env values.
    pub fn copyable_summary(&self) -> Result<String> {
        let p = self.platform_info();
        let mut s = String::new();
        s.push_str(&format!("AgentPort {}\n", p.app_version));
        s.push_str(&format!(
            "Platform: {} {} ({})\n",
            p.os, p.os_version, p.arch
        ));

        s.push_str("Adapters:\n");
        let adapters = self.db.list_adapters()?;
        if adapters.is_empty() {
            s.push_str("- (none probed yet)\n");
        }
        for a in &adapters {
            s.push_str(&format!(
                "- {} {} | exact_resume={} hooks={} probed_at={} [{}]\n",
                a.agent_type.as_str(),
                one_line(&a.version_text),
                a.exact_resume,
                a.hook_status.as_str(),
                a.probed_at.to_rfc3339(),
                a.executable_path // absolute paths are allowed; env values never
            ));
        }

        let hosts = self.host_list()?;
        s.push_str("Hosts:\n");
        if hosts.is_empty() {
            s.push_str("- (no sessions)\n");
        }
        for h in &hosts {
            s.push_str(&format!(
                "- {} \"{}\" lifecycle={} alive={} log={}\n",
                h.session_id,
                one_line(&h.title),
                h.lifecycle,
                h.alive,
                human_bytes(h.log_bytes)
            ));
        }

        // Redaction audit: counts only, per session and total (PRD 3.7).
        let mut total = 0u64;
        let mut per_session = String::new();
        for h in &hosts {
            let n = self.db.redaction_hits_total(&h.session_id)?;
            if n > 0 {
                per_session.push_str(&format!("- {}: {}\n", h.session_id, n));
            }
            total += n;
        }
        s.push_str(&format!("Redaction hits: {total}\n"));
        s.push_str(&per_session);
        Ok(s)
    }

    /// adapter-capabilities.json content for the diagnostics zip.
    pub fn adapter_capabilities_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(&self.db.list_adapters()?)?)
    }
}

/// macOS: `sw_vers -productVersion` via argv — never through a shell.
#[cfg(target_os = "macos")]
fn os_version() -> String {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

/// Linux: PRETTY_NAME from /etc/os-release, best-effort.
#[cfg(target_os = "linux")]
fn os_version() -> String {
    if let Ok(txt) = std::fs::read_to_string("/etc/os-release") {
        for line in txt.lines() {
            if let Some(v) = line.strip_prefix("PRETTY_NAME=") {
                let v = v.trim().trim_matches('"');
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    "unknown".into()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn os_version() -> String {
    "unknown".into()
}

/// Single-line rendering for user-controlled strings in the summary.
fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}

fn human_bytes(n: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = 1024 * 1024;
    if n >= MIB {
        format!("{:.1} MiB", n as f64 / MIB as f64)
    } else if n >= KIB {
        format!("{:.1} KiB", n as f64 / KIB as f64)
    } else {
        format!("{n} B")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{
        AdapterInstall, AgentType, HookStatus, Lifecycle, LogCursor, PermissionMode, Project,
        ResumePrecision, SecretBackend, SecretRef, Session,
    };
    use chrono::Utc;
    use std::path::Path;

    const SECRET: &[u8] = b"diag-secret-value-99";

    struct Fx {
        dir: tempfile::TempDir,
        paths: AppPaths,
        db: Db,
    }

    fn fx() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        Fx {
            paths: AppPaths::new(dir.path().join("data")),
            db: Db::open_memory().unwrap(),
            dir,
        }
    }

    fn add_project(db: &Db) {
        db.add_project(&Project {
            id: "prj_1".into(),
            name: "demo".into(),
            root_path: "/tmp/prj_1".into(),
            git_root_path: None,
            created_at: Utc::now(),
            pinned: false,
            sort_order: 0,
        })
        .unwrap();
    }

    fn add_session(db: &Db, id: &str, _log: &Path) -> Session {
        let s = Session {
            id: id.into(),
            project_id: "prj_1".into(),
            worktree_id: None,
            preset_id: "pre_test".into(),
            title: format!("title of {id}"),
            cwd: "/tmp/cwd".into(),
            host_pid: None,
            host_socket: None,
            host_token: crate::ids::new_host_token(),
            lifecycle: Lifecycle::Running,
            agent_session_id: None,
            resume_precision: ResumePrecision::Unavailable,
            adapter_type: AgentType::Kimi,
            transport: crate::models::AgentTransport::Pty,
            command: vec![],
            permission_mode: PermissionMode::Native,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            pinned_at: None,
            archived_at: None,
        };
        db.insert_session(&s).unwrap();
        s
    }

    #[test]
    fn platform_info_fields_present() {
        let fx = fx();
        let d = Diagnostics {
            paths: &fx.paths,
            db: &fx.db,
        };
        let p = d.platform_info();
        assert!(!p.os.is_empty());
        assert!(!p.os_version.is_empty());
        assert!(!p.arch.is_empty());
        assert_eq!(p.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(p.webview, None); // GUI layer fills this
        #[cfg(target_os = "macos")]
        assert_eq!(p.os, "macos");
        #[cfg(target_os = "linux")]
        assert_eq!(p.os, "linux");
    }

    #[test]
    fn adapter_capabilities_json_contains_upserted_adapter() {
        let fx = fx();
        let d = Diagnostics {
            paths: &fx.paths,
            db: &fx.db,
        };
        fx.db
            .upsert_adapter(&AdapterInstall {
                agent_type: AgentType::Kimi,
                executable_path: "/usr/local/bin/kimi".into(),
                version_text: "0.27.0".into(),
                capability_hash: "sha256:abc".into(),
                exact_resume: true,
                hook_status: HookStatus::Supported,
                approval_model: AgentType::Kimi.approval_model(),
                default_transport: AgentType::Kimi.default_transport(),
                probed_at: Utc::now(),
                candidates: vec![],
                flags: vec!["session".into()],
            })
            .unwrap();
        let json = d.adapter_capabilities_json().unwrap();
        let adapters: Vec<AdapterInstall> = serde_json::from_str(&json).unwrap();
        assert_eq!(adapters.len(), 1);
        assert_eq!(adapters[0].agent_type, AgentType::Kimi);
        assert!(adapters[0].exact_resume);
        assert!(json.contains("0.27.0"));
    }

    #[test]
    fn copyable_summary_counts_hits_and_never_leaks_secret() {
        let fx = fx();
        add_project(&fx.db);
        // Log on disk contains a secret; the summary must never echo it.
        let log = fx.dir.path().join("s.log");
        std::fs::write(&log, b"token=diag-secret-value-99\nhello\n").unwrap();
        add_session(&fx.db, "ses_1", &log);
        // secret ref metadata only (env NAME is fine, env VALUE never appears).
        fx.db
            .upsert_secret_ref(&SecretRef {
                id: "sec_1".into(),
                env_name: "KIMI_API_KEY".into(),
                backend: SecretBackend::MacosKeychain,
                service: "agentport".into(),
                account: "pre_test:KIMI_API_KEY".into(),
                updated_at: Utc::now(),
            })
            .unwrap();
        fx.db.record_redaction_hits("ses_1", 3).unwrap();
        fx.db.record_redaction_hits("ses_1", 2).unwrap();

        let d = Diagnostics {
            paths: &fx.paths,
            db: &fx.db,
        };
        let s = d.copyable_summary().unwrap();
        assert!(s.contains("Redaction hits: 5"), "{s}");
        assert!(s.contains("- ses_1: 5"), "{s}");
        assert!(s.contains("title of ses_1"), "{s}");
        assert!(s.contains("lifecycle=running"), "{s}");
        assert!(!s.contains(std::str::from_utf8(SECRET).unwrap()), "{s}");
        // The summary renders metadata only — no env name/env value dumps.
        assert!(!s.contains("KIMI_API_KEY"), "{s}");
    }

    #[test]
    fn host_list_marks_dead_socket_not_alive() {
        let fx = fx();
        add_project(&fx.db);
        let log = fx.dir.path().join("h.log");
        // Session whose recorded socket path is stale (host long gone):
        // connect() fails fast -> alive=false.
        let mut s1 = add_session(&fx.db, "ses_dead", &log);
        // The reported size is what the Host emitted (durable cursor), not a
        // file: the run-scoped PTY body copy is no longer written.
        fx.db
            .set_latest_log_cursor(
                "ses_dead",
                &LogCursor {
                    run_id: crate::ids::new_id("run"),
                    run_ordinal: 1,
                    generation: 0,
                    offset: 5,
                },
            )
            .unwrap();
        fx.db
            .update_session_host(
                "ses_dead",
                Some(999_999),
                Some("/nonexistent/agentport-dead.sock"),
            )
            .unwrap();
        s1.host_socket = Some("/nonexistent/agentport-dead.sock".into());
        // Session with no host at all.
        add_session(&fx.db, "ses_idle", &log);

        let d = Diagnostics {
            paths: &fx.paths,
            db: &fx.db,
        };
        let hosts = d.host_list().unwrap();
        assert_eq!(hosts.len(), 2);
        let dead = hosts.iter().find(|h| h.session_id == "ses_dead").unwrap();
        assert!(!dead.alive);
        assert_eq!(dead.log_bytes, 5);
        assert_eq!(dead.host_pid, Some(999_999));
        assert_eq!(
            dead.socket_path.as_deref(),
            Some("/nonexistent/agentport-dead.sock")
        );
        assert_eq!(dead.lifecycle, "running");
        let idle = hosts.iter().find(|h| h.session_id == "ses_idle").unwrap();
        assert!(!idle.alive);
        assert_eq!(idle.socket_path, None);
    }
}
