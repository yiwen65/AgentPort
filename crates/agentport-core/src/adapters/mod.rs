//! Agent adapters (PRD 3.1, 3.4, 4.2).
//!
//! Hard rules:
//! - Never assume flags/hooks/session-id interfaces are stable: probe at
//!   runtime (version + --help), record a capability snapshot, degrade safely
//!   on unknown versions instead of guessing.
//! - Never modify the user's global CLI config silently. Only per-invocation,
//!   official, reversible integration flags (e.g. `claude --settings`,
//!   `codex -c notify=...`) may be used; otherwise mark hooks degraded.
//! - Default permission mode is `native`: no auto-approve/bypass flags unless
//!   the preset explicitly enables them (PRD 1.4).
//! - Unknown CLI version -> safe default behavior + degraded status, or block
//!   launch with a clear error. Never invent parameters.

use crate::error::Result;
use crate::models::*;
use std::path::Path;

pub mod capability;

pub mod claude;
pub mod codex;
pub mod kimi;
pub mod pi;
pub mod qoder;
pub mod shell;

/// Everything needed to compose a launch command for a NEW session.
#[derive(Debug, Clone)]
pub struct LaunchContext {
    pub install: AdapterInstall,
    pub preset: Preset,
    pub cwd: String,
    /// AgentPort session id (for hook payload correlation).
    pub session_id: String,
    /// File CLI hooks append JSON events to (session-local).
    pub hook_events_path: String,
    /// Data dir for per-session helper files (e.g. claude settings json).
    pub session_dir: String,
    pub transport: AgentTransport,
}

/// Everything needed to compose a RESUME command.
#[derive(Debug, Clone)]
pub struct ResumeContext {
    pub install: AdapterInstall,
    pub preset: Preset,
    /// Permission mode persisted on the Session being resumed. This is
    /// intentionally separate from the preset, which may have changed since
    /// the Session was created.
    pub permission_mode: PermissionMode,
    pub cwd: String,
    pub agent_session_id: Option<String>,
    pub session_id: String,
    pub hook_events_path: String,
    pub session_dir: String,
    pub transport: AgentTransport,
}

impl ResumeContext {
    fn to_launch_context(&self) -> LaunchContext {
        let mut preset = self.preset.clone();
        preset.permission_mode = self.permission_mode;
        LaunchContext {
            install: self.install.clone(),
            preset,
            cwd: self.cwd.clone(),
            session_id: self.session_id.clone(),
            hook_events_path: self.hook_events_path.clone(),
            session_dir: self.session_dir.clone(),
            transport: self.transport,
        }
    }
}

/// Stable application notice with a compatibility message for older clients.
#[derive(Debug, Clone)]
pub struct LaunchNotice {
    pub code: &'static str,
    pub legacy_message: String,
}

impl LaunchNotice {
    pub fn new(code: &'static str, legacy_message: impl Into<String>) -> Self {
        Self {
            code,
            legacy_message: legacy_message.into(),
        }
    }
}

/// Result of composing a launch/resume command.
#[derive(Debug, Clone)]
pub struct LaunchPlan {
    /// Final argv — array form, no shell.
    pub argv: Vec<String>,
    /// Extra env (non-secret) e.g. markers for hooks.
    pub env: Vec<(String, String)>,
    /// Set when the adapter can assign/pre-determine the native session id
    /// (e.g. claude --session-id). Host still confirms capture when possible.
    pub assigned_agent_session_id: Option<String>,
    pub resume_precision: ResumePrecision,
    pub hook_status: HookStatus,
    pub transport: AgentTransport,
    /// Helper files that must exist before spawn (path, contents, mode 0600).
    pub helper_files: Vec<(String, String)>,
    /// The GUI localizes `code`; `legacy_message` keeps older clients and
    /// diagnostics compatible without parallel vectors that can drift.
    pub notices: Vec<LaunchNotice>,
}

pub trait AgentAdapter: Send + Sync {
    fn agent_type(&self) -> AgentType;

    /// Parse `--version` and `--help` output into a capability snapshot.
    /// Pure parsing — no process execution here (probing runs in capability.rs).
    fn parse_capabilities(
        &self,
        exe: &Path,
        version_out: &str,
        help_out: &str,
    ) -> Result<AdapterInstall>;

    fn build_launch(&self, ctx: &LaunchContext) -> Result<LaunchPlan>;
    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan>;

    /// Environment-aware resume planning. Adapters may verify on-disk state
    /// before committing to resume-by-id (claude checks that the recorded
    /// conversation transcript actually exists, since resume-by-id exits 1
    /// with "No conversation found" otherwise). Default: plain build_resume.
    fn build_resume_checked(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        self.build_resume(ctx)
    }

    /// Extra PTY heuristic patterns (merged over the shared defaults).
    fn extra_pty_patterns(&self) -> (Vec<String>, Vec<String>) {
        (vec![], vec![]) // (needs_input, working)
    }

    /// Try to extract a native session id from PTY output text (stripped of
    /// ANSI). Returns None when this adapter/version cannot — never guesses.
    fn extract_session_id(&self, _stripped_text_tail: &str) -> Option<String> {
        None
    }
}

pub fn adapter_for(t: AgentType) -> Box<dyn AgentAdapter> {
    match t {
        AgentType::Claude => Box::new(claude::ClaudeAdapter),
        AgentType::Codex => Box::new(codex::CodexAdapter),
        AgentType::Kimi => Box::new(kimi::KimiAdapter),
        AgentType::Qoder => Box::new(qoder::QoderAdapter),
        AgentType::Pi => Box::new(pi::PiAdapter),
        AgentType::Shell => Box::new(shell::ShellAdapter),
    }
}

/// Extract normalized long-flag names (`--session-id` -> "session-id") from
/// --help text. Sorted, deduped. This is the capability ground truth — every
/// flag we ever pass must be present here first.
pub(crate) fn extract_flags(help_out: &str) -> Vec<String> {
    let re = regex::Regex::new(r"--([a-zA-Z0-9][a-zA-Z0-9-]*)").unwrap();
    let mut flags: Vec<String> = re
        .captures_iter(help_out)
        .map(|c| c[1].to_string())
        .collect();
    flags.sort();
    flags.dedup();
    flags
}

/// Version text kept in snapshots: trimmed, max 200 chars.
pub(crate) fn normalize_version(version_out: &str) -> String {
    version_out.trim().chars().take(200).collect()
}

pub(crate) fn has_flag(install: &AdapterInstall, flag: &str) -> bool {
    install.flags.iter().any(|f| f == flag)
}

/// Arguments that would bypass AgentPort's ownership of cwd, native-session
/// identity, transport, permissions, or lifecycle are never accepted from a
/// preset or the advanced argv field.
pub fn validate_user_args(t: AgentType, args: &[String]) -> Result<()> {
    let protected: &[&str] = match t {
        AgentType::Qoder => &[
            "--cwd",
            "--config-dir",
            "--worktree",
            "--continue",
            "--resume",
            "--session-id",
            "--remote",
            "--remote-session",
            "--teleport",
            "--remote-control",
            "--print",
            "--no-session-persistence",
            "--settings",
            "--permission-mode",
            "--dangerously-skip-permissions",
        ],
        AgentType::Pi => &[
            "--mode",
            "--print",
            "-p",
            "--continue",
            "--resume",
            "--session",
            "--session-id",
            "--session-dir",
            "--no-session",
            "--fork",
            "--api-key",
            "--approve",
            "-a",
            "--no-approve",
            "-na",
            "--extension",
            "-e",
            "--no-extensions",
            "-ne",
            "--skill",
            "--no-skills",
            "-ns",
            "--prompt-template",
            "--no-prompt-templates",
            "--theme",
            "--no-themes",
        ],
        _ => &[],
    };
    for arg in args {
        let key = arg.split('=').next().unwrap_or(arg.as_str());
        if protected.contains(&key) {
            return Err(crate::error::CoreError::Validation(format!(
                "{} argument is managed by AgentPort and cannot be overridden in a preset or advanced arguments: {key}",
                t.display_name()
            )));
        }
    }
    Ok(())
}

/// Apply permission mode to an argv under construction.
/// `native` adds NOTHING. `auto`/`bypass` add the CLI-specific flag when the
/// probed capabilities prove it exists; otherwise return an error — never
/// silently pass an unknown flag to a real CLI.
pub fn permission_argv(
    t: AgentType,
    mode: PermissionMode,
    install: &AdapterInstall,
) -> Result<Vec<String>> {
    use AgentType::*;
    use PermissionMode::*;
    if mode == Native {
        return Ok(vec![]);
    }
    if t == Shell || t == Pi {
        // Shell has no approval concept; auto/bypass is meaningless there.
        return Err(crate::error::CoreError::Validation(
            "shell adapter only supports native permission mode".into(),
        ));
    }
    // Flag names verified against real --help fixtures (claude 2.1.214,
    // codex 0.144.5, kimi 0.27.0 — see tests/fixtures/cli/).
    let argv: &[&str] = match (t, mode) {
        (Claude, Auto) => &["--permission-mode", "acceptEdits"],
        (Claude, Bypass) => &["--dangerously-skip-permissions"],
        (Codex, Auto) => &["--ask-for-approval", "never"],
        (Codex, Bypass) => &["--dangerously-bypass-approvals-and-sandbox"],
        (Kimi, Auto) => &["--auto"],
        (Kimi, Bypass) => &["--yolo"],
        (Qoder, Auto) => &["--permission-mode", "auto"],
        (Qoder, Bypass) => &["--dangerously-skip-permissions"],
        (Pi | Shell, _) => unreachable!(),
        (Claude | Codex | Kimi | Qoder, Native) => unreachable!(),
    };
    let flag = argv[0].trim_start_matches('-');
    if !install.flags.iter().any(|f| f == flag) {
        return Err(crate::error::CoreError::Adapter(format!(
            "flag not supported by probed version: --{flag}"
        )));
    }
    Ok(argv.iter().map(|s| s.to_string()).collect())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod test_fixtures {
    use crate::models::*;
    use std::path::{Path, PathBuf};

    pub fn fixture_path(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/cli")
            .join(name)
    }

    pub fn read_fixture(name: &str) -> String {
        std::fs::read_to_string(fixture_path(name))
            .unwrap_or_else(|e| panic!("read fixture {name}: {e}"))
    }

    pub fn install(t: AgentType, flags: &[&str]) -> AdapterInstall {
        AdapterInstall {
            agent_type: t,
            executable_path: format!("/fake/bin/{}", t.as_str()),
            version_text: "test 0.0.0".into(),
            capability_hash: "sha256:0000000000000000".into(),
            exact_resume: true,
            hook_status: HookStatus::Supported,
            approval_model: t.approval_model(),
            default_transport: t.default_transport(),
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags: flags.iter().map(|s| s.to_string()).collect(),
        }
    }

    pub fn preset(t: AgentType, mode: PermissionMode) -> Preset {
        Preset {
            id: "pre_test".into(),
            agent_type: t,
            name: "test".into(),
            executable_path: String::new(),
            args: vec![],
            permission_mode: mode,
            env_names: vec![],
            secret_ref_ids: vec![],
            built_in: false,
        }
    }

    pub fn launch_ctx(t: AgentType, flags: &[&str], mode: PermissionMode) -> super::LaunchContext {
        super::LaunchContext {
            install: install(t, flags),
            preset: preset(t, mode),
            cwd: "/tmp/work".into(),
            session_id: "ses_test".into(),
            hook_events_path: "/tmp/work/.agentport/hook-events.jsonl".into(),
            session_dir: "/tmp/work/.agentport".into(),
            transport: t.default_transport(),
        }
    }

    pub fn resume_ctx(
        t: AgentType,
        flags: &[&str],
        agent_session_id: Option<&str>,
    ) -> super::ResumeContext {
        super::ResumeContext {
            install: install(t, flags),
            preset: preset(t, PermissionMode::Native),
            permission_mode: PermissionMode::Native,
            cwd: "/tmp/work".into(),
            agent_session_id: agent_session_id.map(str::to_string),
            session_id: "ses_test".into(),
            hook_events_path: "/tmp/work/.agentport/hook-events.jsonl".into(),
            session_dir: "/tmp/work/.agentport".into(),
            transport: t.default_transport(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::CoreError;

    fn inst(t: AgentType, flags: &[&str]) -> AdapterInstall {
        test_fixtures::install(t, flags)
    }

    #[test]
    fn permission_native_always_empty() {
        for t in [
            AgentType::Claude,
            AgentType::Codex,
            AgentType::Kimi,
            AgentType::Shell,
        ] {
            let i = inst(t, &[]);
            assert_eq!(
                permission_argv(t, PermissionMode::Native, &i).unwrap(),
                Vec::<String>::new()
            );
        }
    }

    #[test]
    fn managed_qoder_and_pi_args_cannot_be_overridden() {
        assert!(validate_user_args(AgentType::Qoder, &["--worktree".into()]).is_err());
        assert!(
            validate_user_args(AgentType::Qoder, &["--dangerously-skip-permissions".into()])
                .is_err()
        );
        assert!(
            validate_user_args(AgentType::Pi, &["--session-id".into(), "other".into()]).is_err()
        );
        assert!(validate_user_args(AgentType::Pi, &["--api-key".into(), "secret".into()]).is_err());
        assert!(validate_user_args(AgentType::Pi, &["--model".into(), "custom".into()]).is_ok());
    }

    #[test]
    fn qoder_respects_the_explicit_native_permission_mode() {
        assert_eq!(
            AgentType::Qoder.effective_permission_mode(PermissionMode::Native),
            PermissionMode::Native
        );
    }

    #[test]
    fn permission_claude_matrix() {
        let flags = &["permission-mode", "dangerously-skip-permissions"];
        let i = inst(AgentType::Claude, flags);
        assert_eq!(
            permission_argv(AgentType::Claude, PermissionMode::Auto, &i).unwrap(),
            vec!["--permission-mode", "acceptEdits"]
        );
        assert_eq!(
            permission_argv(AgentType::Claude, PermissionMode::Bypass, &i).unwrap(),
            vec!["--dangerously-skip-permissions"]
        );
        // flag 缺失 -> Adapter 错误，绝不静默传参
        let missing = inst(AgentType::Claude, &[]);
        for mode in [PermissionMode::Auto, PermissionMode::Bypass] {
            match permission_argv(AgentType::Claude, mode, &missing) {
                Err(CoreError::Adapter(m)) => {
                    assert!(m.contains("flag not supported by probed version"))
                }
                other => panic!("expected Adapter error, got {other:?}"),
            }
        }
    }

    #[test]
    fn permission_codex_matrix() {
        // 0.144.5 实测：auto=-a never，bypass=--dangerously-bypass-approvals-and-sandbox
        let flags = &[
            "ask-for-approval",
            "dangerously-bypass-approvals-and-sandbox",
        ];
        let i = inst(AgentType::Codex, flags);
        assert_eq!(
            permission_argv(AgentType::Codex, PermissionMode::Auto, &i).unwrap(),
            vec!["--ask-for-approval", "never"]
        );
        assert_eq!(
            permission_argv(AgentType::Codex, PermissionMode::Bypass, &i).unwrap(),
            vec!["--dangerously-bypass-approvals-and-sandbox"]
        );
        let missing = inst(AgentType::Codex, &[]);
        for mode in [PermissionMode::Auto, PermissionMode::Bypass] {
            assert!(matches!(
                permission_argv(AgentType::Codex, mode, &missing),
                Err(CoreError::Adapter(_))
            ));
        }
    }

    #[test]
    fn permission_kimi_matrix() {
        let flags = &["auto", "yolo"];
        let i = inst(AgentType::Kimi, flags);
        assert_eq!(
            permission_argv(AgentType::Kimi, PermissionMode::Auto, &i).unwrap(),
            vec!["--auto"]
        );
        assert_eq!(
            permission_argv(AgentType::Kimi, PermissionMode::Bypass, &i).unwrap(),
            vec!["--yolo"]
        );
        let missing = inst(AgentType::Kimi, &[]);
        for mode in [PermissionMode::Auto, PermissionMode::Bypass] {
            assert!(matches!(
                permission_argv(AgentType::Kimi, mode, &missing),
                Err(CoreError::Adapter(_))
            ));
        }
    }

    #[test]
    fn permission_shell_non_native_is_validation_error() {
        let i = inst(AgentType::Shell, &[]);
        for mode in [PermissionMode::Auto, PermissionMode::Bypass] {
            assert!(matches!(
                permission_argv(AgentType::Shell, mode, &i),
                Err(CoreError::Validation(_))
            ));
        }
    }

    #[test]
    fn extract_flags_normalizes_long_flags() {
        let help =
            "  -S, --session [id]  Resume\n  --dangerously-skip-permissions\n--session duplicate";
        let flags = extract_flags(help);
        assert_eq!(flags, vec!["dangerously-skip-permissions", "session"]);
    }
}
