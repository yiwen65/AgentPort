//! Best-effort deletion of agent-owned native session artifacts.
//!
//! Permanently purging an archived Session removes AgentPort's database rows
//! and its own session directory, but the agent's native transcript files
//! (for example `~/.claude/projects/<slug>/<id>.jsonl`) would otherwise leak.
//! This module plans the exact per-Session native targets *before* the
//! database purge commits — while the hook-events evidence still exists — and
//! executes the deletion afterwards on a best-effort basis.
//!
//! Safety contract:
//! - targets are selected only by an exact native session id match (plus the
//!   recorded cwd where the provider layout requires it);
//! - every target is canonicalized and must stay strictly inside the
//!   provider's configuration root, so a whole project directory is never
//!   deleted;
//! - deletion is idempotent: a missing file counts as success, matching the
//!   existing session-directory cleanup semantics.

use crate::history::{
    codex_file_matches, collect_jsonl_files, collect_native_ids, configured_home, cwd_slug,
    read_kimi_session_index, MAX_NATIVE_SOURCES,
};
use crate::models::{AgentType, Session};
use crate::paths::AppPaths;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

/// One filesystem object selected for deletion. `root` is retained so the
/// containment invariant can be re-verified at execution time.
#[derive(Debug, Clone, PartialEq, Eq)]
enum CleanupTarget {
    File { root: PathBuf, path: PathBuf },
    Directory { root: PathBuf, path: PathBuf },
}

impl CleanupTarget {
    fn path(&self) -> &Path {
        match self {
            CleanupTarget::File { path, .. } | CleanupTarget::Directory { path, .. } => path,
        }
    }
}

/// Deletion plan for one purged Session. Built before the database purge
/// commits so native-id evidence (hook events) is still readable.
#[derive(Debug, Clone, Default)]
pub struct NativeCleanupPlan {
    targets: Vec<CleanupTarget>,
}

impl NativeCleanupPlan {
    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    pub fn target_count(&self) -> usize {
        self.targets.len()
    }
}

/// Result of a best-effort execution. Failure reasons are fixed labels rather
/// than OS error strings, so no absolute filesystem path or other
/// environment-specific detail is propagated to callers or logs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeCleanupOutcome {
    pub deleted: usize,
    pub failures: Vec<&'static str>,
}

impl NativeCleanupOutcome {
    pub fn has_failures(&self) -> bool {
        !self.failures.is_empty()
    }
}

/// Canonicalize `path` and require it to exist and to lie strictly inside
/// `root`. Rejecting equality with the root guarantees a provider project
/// directory (or worse) is never selected as a target.
fn contained(path: &Path, root: &Path) -> Option<PathBuf> {
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    if path != root && path.starts_with(&root) {
        Some(path)
    } else {
        None
    }
}

fn push_target(plan: &mut NativeCleanupPlan, target: CleanupTarget) {
    if plan.targets.len() >= MAX_NATIVE_SOURCES {
        return;
    }
    if plan.targets.iter().any(|known| known.path() == target.path()) {
        return;
    }
    plan.targets.push(target);
}

/// Build the deletion plan for one Session that is about to be purged.
///
/// Pi history published under .epi is retained, not part of AgentPort's
/// external deletion plan. Legacy `session_dir/pi` copies remain subject to
/// the existing explicit session-directory cleanup; no .epi tree is deleted.
pub fn plan_native_cleanup(paths: &AppPaths, session: &Session) -> NativeCleanupPlan {
    let mut plan = NativeCleanupPlan::default();
    match session.adapter_type {
        AgentType::Shell | AgentType::Pi => return plan,
        _ => {}
    }
    let native_ids = collect_native_ids(paths, session);
    if native_ids.is_empty() {
        return plan;
    }
    match session.adapter_type {
        AgentType::Claude => plan_claude(&mut plan, session, &native_ids),
        AgentType::Codex => plan_codex(&mut plan, session, &native_ids),
        AgentType::Kimi => plan_kimi(&mut plan, session, &native_ids),
        AgentType::Qoder => plan_qoder(&mut plan, session, &native_ids),
        AgentType::Shell | AgentType::Pi => unreachable!(),
    }
    plan
}

fn plan_claude(plan: &mut NativeCleanupPlan, session: &Session, native_ids: &[String]) {
    let root = configured_home("CLAUDE_CONFIG_DIR", ".claude").join("projects");
    let project = root.join(cwd_slug(&session.cwd));
    for id in native_ids {
        if let Some(path) = contained(&project.join(format!("{id}.jsonl")), &root) {
            if path.is_file() {
                push_target(
                    plan,
                    CleanupTarget::File {
                        root: root.clone(),
                        path,
                    },
                );
            }
        }
        // Some Claude versions keep per-session side artifacts (for example
        // subagent transcripts) in a directory named after the session id.
        let side_dir = project.join(id);
        if side_dir.is_dir() {
            if let Some(path) = contained(&side_dir, &root) {
                push_target(
                    plan,
                    CleanupTarget::Directory {
                        root: root.clone(),
                        path,
                    },
                );
            }
        }
    }
}

fn plan_codex(plan: &mut NativeCleanupPlan, session: &Session, native_ids: &[String]) {
    let root = configured_home("CODEX_HOME", ".codex").join("sessions");
    let mut files = Vec::new();
    collect_jsonl_files(&root, 5, &mut files);
    for id in native_ids {
        for candidate in files
            .iter()
            .filter(|path| codex_file_matches(path, id, &session.cwd))
        {
            if let Some(path) = contained(candidate, &root) {
                if path.is_file() {
                    push_target(
                        plan,
                        CleanupTarget::File {
                            root: root.clone(),
                            path,
                        },
                    );
                }
            }
        }
    }
}

fn plan_kimi(plan: &mut NativeCleanupPlan, session: &Session, native_ids: &[String]) {
    let home = configured_home("KIMI_CODE_HOME", ".kimi-code");
    let root = home.join("sessions");
    let wanted: HashSet<&str> = native_ids.iter().map(String::as_str).collect();
    for entry in read_kimi_session_index(&home) {
        let Some(id) = entry.get("sessionId").and_then(|value| value.as_str()) else {
            continue;
        };
        if !wanted.contains(id)
            || entry.get("workDir").and_then(|value| value.as_str()) != Some(session.cwd.as_str())
        {
            continue;
        }
        let Some(dir) = entry.get("sessionDir").and_then(|value| value.as_str()) else {
            continue;
        };
        let dir = PathBuf::from(dir);
        if dir.is_dir() {
            if let Some(path) = contained(&dir, &root) {
                push_target(
                    plan,
                    CleanupTarget::Directory {
                        root: root.clone(),
                        path,
                    },
                );
            }
        }
    }
}

fn plan_qoder(plan: &mut NativeCleanupPlan, session: &Session, native_ids: &[String]) {
    let root = configured_home("QODER_HOME", ".qoder").join("logs/sessions");
    let project = root.join(cwd_slug(&session.cwd));
    for id in native_ids {
        let dir = project.join(id);
        if dir.is_dir() {
            if let Some(path) = contained(&dir, &root) {
                push_target(
                    plan,
                    CleanupTarget::Directory {
                        root: root.clone(),
                        path,
                    },
                );
            }
        }
    }
}

/// Execute a plan on a best-effort basis. Missing files are treated as
/// already deleted; genuine failures are reported as fixed labels so the
/// caller can warn without leaking filesystem details.
pub fn execute_native_cleanup(plan: &NativeCleanupPlan) -> NativeCleanupOutcome {
    let mut outcome = NativeCleanupOutcome::default();
    // Files first, then directories, so a directory target cannot remove a
    // not-yet-verified file target from under us.
    let mut ordered: Vec<&CleanupTarget> = plan.targets.iter().collect();
    ordered.sort_by_key(|target| match target {
        CleanupTarget::File { .. } => 0,
        CleanupTarget::Directory { .. } => 1,
    });
    for target in ordered {
        let (root, path, is_directory) = match target {
            CleanupTarget::File { root, path } => (root, path, false),
            CleanupTarget::Directory { root, path } => (root, path, true),
        };
        // Re-verify containment at execution time: the plan was built earlier
        // and the filesystem may have changed since.
        let still_contained = root
            .canonicalize()
            .ok()
            .zip(path.canonicalize().ok())
            .is_some_and(|(root, path)| path != root && path.starts_with(&root));
        let missing = path.symlink_metadata().is_err();
        if !still_contained && !missing {
            outcome.failures.push("native_target_escapes_root");
            continue;
        }
        let result = if is_directory {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(()) => outcome.deleted += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Idempotent: already gone counts as success.
            }
            Err(_) => outcome.failures.push(if is_directory {
                "remove_native_directory_failed"
            } else {
                "remove_native_file_failed"
            }),
        }
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{Lifecycle, PermissionMode, ResumePrecision};
    use chrono::Utc;
    use tempfile::TempDir;

    fn session(root: &Path, provider: AgentType, native_id: Option<&str>) -> Session {
        Session {
            id: "ses_cleanup".into(),
            project_id: "prj_1".into(),
            worktree_id: None,
            preset_id: "pre_1".into(),
            title: "cleanup".into(),
            cwd: root.join("workspace").to_string_lossy().into_owned(),
            host_pid: None,
            host_socket: None,
            host_token: "token".into(),
            lifecycle: Lifecycle::Exited,
            agent_session_id: native_id.map(str::to_string),
            resume_precision: ResumePrecision::Exact,
            log_path: root.join("legacy.log").to_string_lossy().into_owned(),
            adapter_type: provider,
            transport: crate::models::AgentTransport::Pty,
            command: vec![],
            permission_mode: PermissionMode::Native,
            pinned_at: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            archived_at: Some(Utc::now()),
        }
    }

    #[test]
    fn claude_plan_deletes_transcripts_and_side_dirs_only_for_matching_ids() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let session = session(temp.path(), AgentType::Claude, Some("new-id"));
        fs::create_dir_all(paths.session_dir(&session.id)).unwrap();
        fs::write(
            paths.hook_events_path(&session.id),
            "{\"data\":{\"session_id\":\"old-id\"}}\n{\"data\":{\"session_id\":\"new-id\"}}\n",
        )
        .unwrap();
        let claude = temp.path().join("claude");
        let project = claude.join("projects").join(cwd_slug(&session.cwd));
        fs::create_dir_all(&project).unwrap();
        for id in ["old-id", "new-id", "other-session"] {
            fs::write(project.join(format!("{id}.jsonl")), "{}\n").unwrap();
        }
        let side_dir = project.join("new-id");
        fs::create_dir_all(&side_dir).unwrap();
        fs::write(side_dir.join("subagent.jsonl"), "{}\n").unwrap();

        std::env::set_var("CLAUDE_CONFIG_DIR", &claude);
        let plan = plan_native_cleanup(&paths, &session);
        let outcome = execute_native_cleanup(&plan);
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        assert_eq!(plan.target_count(), 3);
        assert_eq!(outcome.deleted, 3);
        assert!(!outcome.has_failures());
        assert!(!project.join("old-id.jsonl").exists());
        assert!(!project.join("new-id.jsonl").exists());
        assert!(!side_dir.exists());
        assert!(
            project.join("other-session.jsonl").exists(),
            "another session's transcript must survive"
        );
        // The shared project directory itself must survive.
        assert!(project.exists());
        // Execution is idempotent.
        let second = execute_native_cleanup(&plan);
        assert_eq!(second.deleted, 0);
        assert!(!second.has_failures());
    }

    #[test]
    fn codex_plan_deletes_only_rollouts_matching_id_and_cwd() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let session = session(temp.path(), AgentType::Codex, Some("codex-native"));
        let codex_home = temp.path().join("codex");
        let matching = codex_home.join("sessions/2026/08/24/rollout-a.jsonl");
        let wrong_id = codex_home.join("sessions/2026/08/24/rollout-b.jsonl");
        let wrong_cwd = codex_home.join("sessions/2026/08/25/rollout-c.jsonl");
        for path in [&matching, &wrong_id, &wrong_cwd] {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
        }
        let meta = |id: &str, cwd: &str| {
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{id}\",\"cwd\":{}}}}}\n",
                serde_json::to_string(cwd).unwrap()
            )
        };
        fs::write(&matching, meta("codex-native", &session.cwd)).unwrap();
        fs::write(&wrong_id, meta("another-session", &session.cwd)).unwrap();
        fs::write(&wrong_cwd, meta("codex-native", "/somewhere/else")).unwrap();

        std::env::set_var("CODEX_HOME", &codex_home);
        let plan = plan_native_cleanup(&paths, &session);
        let outcome = execute_native_cleanup(&plan);
        std::env::remove_var("CODEX_HOME");

        assert_eq!(plan.target_count(), 1);
        assert_eq!(outcome.deleted, 1);
        assert!(!matching.exists());
        assert!(wrong_id.exists());
        assert!(wrong_cwd.exists());
    }

    #[test]
    fn kimi_plan_deletes_indexed_session_dir_and_rejects_escapes() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let session = session(temp.path(), AgentType::Kimi, Some("kimi-native"));
        let kimi_home = temp.path().join("kimi");
        let session_dir = kimi_home.join("sessions/work/kimi-native");
        let other_dir = kimi_home.join("sessions/work/other");
        fs::create_dir_all(session_dir.join("agents/main")).unwrap();
        fs::create_dir_all(&other_dir).unwrap();
        fs::write(session_dir.join("agents/main/wire.jsonl"), "{}\n").unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let entry = |id: &str, work_dir: &str, dir: &Path| {
            format!(
                "{{\"sessionId\":\"{id}\",\"workDir\":{},\"sessionDir\":{}}}\n",
                serde_json::to_string(work_dir).unwrap(),
                serde_json::to_string(&dir.to_string_lossy()).unwrap()
            )
        };
        let mut index = String::new();
        // Matching entry: deleted. Non-matching id, wrong cwd, and escape
        // attempts: ignored.
        index.push_str(&entry("kimi-native", &session.cwd, &session_dir));
        index.push_str(&entry("kimi-native", &session.cwd, &outside));
        index.push_str(&entry("kimi-native", &session.cwd, &kimi_home.join("sessions")));
        index.push_str(&entry("other", &session.cwd, &other_dir));
        index.push_str(&entry("kimi-native", "/somewhere/else", &other_dir));
        fs::write(kimi_home.join("session_index.jsonl"), index).unwrap();

        std::env::set_var("KIMI_CODE_HOME", &kimi_home);
        let plan = plan_native_cleanup(&paths, &session);
        let outcome = execute_native_cleanup(&plan);
        std::env::remove_var("KIMI_CODE_HOME");

        assert_eq!(plan.target_count(), 1);
        assert_eq!(outcome.deleted, 1);
        assert!(!session_dir.exists());
        assert!(outside.exists(), "escape attempt must not be deleted");
        assert!(
            kimi_home.join("sessions").exists(),
            "provider root must never be a target"
        );
        assert!(other_dir.exists());
    }

    #[test]
    fn qoder_plan_deletes_only_the_matching_session_directory() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let session = session(temp.path(), AgentType::Qoder, Some("qoder-native"));
        let qoder_home = temp.path().join("qoder");
        let project = qoder_home
            .join("logs/sessions")
            .join(cwd_slug(&session.cwd));
        let matching = project.join("qoder-native");
        let other = project.join("other-session");
        fs::create_dir_all(matching.join("segments")).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(matching.join("segments/001.jsonl"), "{}\n").unwrap();

        std::env::set_var("QODER_HOME", &qoder_home);
        let plan = plan_native_cleanup(&paths, &session);
        let outcome = execute_native_cleanup(&plan);
        std::env::remove_var("QODER_HOME");

        assert_eq!(plan.target_count(), 1);
        assert_eq!(outcome.deleted, 1);
        assert!(!matching.exists());
        assert!(other.exists());
    }

    #[test]
    fn pi_shell_and_idless_sessions_have_no_native_plan() {
        let temp = TempDir::new().unwrap();
        let paths = AppPaths::new(temp.path().join("data"));
        let pi = session(temp.path(), AgentType::Pi, Some("pi-native"));
        assert!(plan_native_cleanup(&paths, &pi).is_empty());
        let shell = session(temp.path(), AgentType::Shell, None);
        assert!(plan_native_cleanup(&paths, &shell).is_empty());
        let claude = session(temp.path(), AgentType::Claude, None);
        assert!(plan_native_cleanup(&paths, &claude).is_empty());
    }
}
