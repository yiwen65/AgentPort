//! Evidence-driven PTY adapters for independently distributed coding CLIs.
//!
//! Interface sources and verification limits: docs/agent-cli-evidence.md.
//! Flags are always checked against the current installation's help snapshot.
//! No global settings, credentials, or native history are read or modified here.

use super::{AgentAdapter, LaunchContext, LaunchNotice, LaunchPlan, ResumeContext};
use crate::error::{CoreError, Result};
use crate::models::*;
use std::path::Path;

pub struct ExtendedAdapter(pub AgentType);

/// A subcommand is not a long flag. Preserve its verified presence separately
/// inside the existing capability snapshot instead of pretending --resume exists.
pub const AMP_CONTINUE_CAPABILITY: &str = "agentport:amp-threads-continue";

fn has(install: &AdapterInstall, flag: &str) -> bool {
    super::has_flag(install, flag)
}

fn exact_flag(agent: AgentType) -> Option<&'static str> {
    match agent {
        AgentType::Opencode => Some("session"),
        AgentType::Amp => Some(AMP_CONTINUE_CAPABILITY),
        AgentType::Gemini | AgentType::CursorAgent | AgentType::GrokBuild => Some("resume"),
        AgentType::Cline => Some("id"),
        AgentType::KiroCli => Some("resume-id"),
        _ => None,
    }
}

fn latest_args(agent: AgentType, install: &AdapterInstall) -> Option<Vec<String>> {
    let args: &[&str] = match agent {
        AgentType::Opencode | AgentType::CursorAgent | AgentType::GrokBuild
            if has(install, "continue") =>
        {
            &["--continue"]
        }
        AgentType::Gemini if has(install, "resume") => &["--resume", "latest"],
        // Kiro's --resume is a boolean, NOT an ID argument.
        AgentType::KiroCli if has(install, "resume") => &["--resume"],
        _ => return None,
    };
    Some(args.iter().map(|s| (*s).into()).collect())
}

/// Permission modes are CLI-specific. None of these flags are inserted for
/// Native, including CLIs whose upstream default already approves tools.
pub fn permission_args(
    agent: AgentType,
    mode: PermissionMode,
    install: &AdapterInstall,
) -> Result<Vec<String>> {
    if mode == PermissionMode::Native {
        return Ok(vec![]);
    }
    use AgentType::*;
    use PermissionMode::*;
    let args: &[&str] = match (agent, mode) {
        (Opencode, Auto) => &["--auto"],
        (Gemini, Auto) => &["--approval-mode", "auto_edit"],
        (Gemini, Bypass) => &["--approval-mode", "yolo"],
        (Cline, Auto | Bypass) => &["--auto-approve", "true"],
        (KiroCli, Auto | Bypass) => &["--trust-all-tools"],
        (CursorAgent, Auto | Bypass) => &["--force"],
        (GrokBuild, Auto) => &["--permission-mode", "acceptEdits"],
        (GrokBuild, Bypass) => &["--permission-mode", "bypassPermissions"],
        _ => {
            return Err(CoreError::Validation(format!(
                "{} does not support the requested permission mode through a verified session-level option",
                agent.display_name()
            )))
        }
    };
    if !has(install, args[0].trim_start_matches('-')) {
        return Err(CoreError::Adapter(format!(
            "{} flag not supported by probed version: {}",
            agent.display_name(),
            args[0]
        )));
    }
    Ok(args.iter().map(|s| (*s).into()).collect())
}

/// Protect ownership of conversation, cwd, transport, approval mode and secrets.
/// Include short aliases: checking only long flags allows accidental overrides.
pub fn protected_args(agent: AgentType) -> &'static [&'static str] {
    match agent {
        AgentType::Opencode => &[
            "--continue",
            "-c",
            "--session",
            "-s",
            "--fork",
            "--auto",
            "--prompt",
            "--dir",
            "--attach",
            "--password",
            "--port",
            "--hostname",
            "--mdns",
            "--mdns-domain",
            "--cors",
        ],
        AgentType::Amp => &[
            "--execute",
            "-x",
            "--no-tui",
            "--stream-json",
            "--stream-json-input",
            "--dangerously-allow-all",
            "--settings-file",
            "--api-key",
            "--executor",
            "--runner-id",
            "--visibility",
            "--cwd",
            "--listen",
            "--ide",
        ],
        AgentType::Gemini => &[
            "--resume",
            "-r",
            "--prompt",
            "-p",
            "--prompt-interactive",
            "-i",
            "--approval-mode",
            "--yolo",
            "-y",
            "--allowed-tools",
            "--sandbox",
            "-s",
            "--skip-trust",
            "--worktree",
            "-w",
            "--output-format",
            "-o",
            "--experimental-acp",
            "--experimental-zed-integration",
            "--list-sessions",
            "--delete-session",
            "--policy",
            "--include-directories",
            "--raw-output",
        ],
        AgentType::Cline => &[
            "--id",
            "--cwd",
            "-c",
            "--config",
            "--data-dir",
            "--json",
            "--acp",
            "--tui",
            "-i",
            "--zen",
            "-z",
            "--auto-approve",
            "--yolo",
            "-y",
            "--key",
            "-k",
            "--api-key",
            "--hooks-dir",
        ],
        AgentType::KiroCli => &[
            "--resume",
            "-r",
            "--resume-id",
            "--resume-picker",
            "--sessions",
            "--list-sessions",
            "--delete-session",
            "--trust-all-tools",
            "--trust-tools",
            "--no-interactive",
            "--wrap",
            "--cloud",
            "--workspace",
            "--cwd",
        ],
        AgentType::CursorAgent => &[
            "--resume",
            "--continue",
            "--workspace",
            "--worktree",
            "-w",
            "--worktree-base",
            "--skip-worktree-setup",
            "--print",
            "-p",
            "--force",
            "-f",
            "--yolo",
            "--sandbox",
            "--trust",
            "--approve-mcps",
            "--api-key",
            "--output-format",
            "--stream-partial-output",
            "--background",
        ],
        AgentType::GrokBuild => &[
            "--session-id",
            "-s",
            "--resume",
            "-r",
            "--continue",
            "-c",
            "--fork-session",
            "--restore-code",
            "--cwd",
            "--worktree",
            "-w",
            "--worktree-ref",
            "--ref",
            "--permission-mode",
            "--always-approve",
            "--yolo",
            "--allow",
            "--allowedTools",
            "--deny",
            "--disallowedTools",
            "--sandbox",
            "--single",
            "-p",
            "--prompt-file",
            "--prompt-json",
            "--output-format",
            "--leader-socket",
            "--oauth",
            "--json-schema",
        ],
        _ => &[],
    }
}

/// Do not accept lifecycle subcommands or initial prompts through advanced argv.
/// Long-option values remain allowed (e.g. --model provider/model), but a bare
/// leading command could turn `amp` into `amp logout`, or `grok` into a remote
/// operation. Attached short forms of owned flags must be rejected as well.
pub fn validate_advanced_args(agent: AgentType, args: &[String]) -> Result<()> {
    let protected = protected_args(agent);
    for arg in args {
        let key = arg.split('=').next().unwrap_or(arg);
        if protected.contains(&key)
            || arg == "--"
            || (arg.starts_with('-')
                && !arg.starts_with("--")
                && protected
                    .iter()
                    .any(|flag| flag.len() == 2 && arg.starts_with(*flag)))
        {
            return Err(CoreError::Validation(format!(
                "{} argument is managed by AgentPort: {arg}",
                agent.display_name()
            )));
        }
    }
    // Known value-taking customization options. Unknown options can still use
    // --name=value, but cannot consume an unchecked positional subcommand.
    let value_options: &[&str] = &[
        "--model",
        "-m",
        "--agent",
        "--mode",
        "--provider",
        "-P",
        "--thinking",
        "--timeout",
        "-t",
        "--reasoning-effort",
        "--effort",
        "--rules",
        "--tools",
        "--disallowed-tools",
        "--max-turns",
        "--retries",
        "--system",
        "--system-prompt",
        "--system-prompt-override",
        "--theme",
        "--log-level",
    ];
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if !arg.starts_with('-') {
            return Err(CoreError::Validation(
                "advanced arguments must be options, not a CLI subcommand or initial prompt".into(),
            ));
        }
        if value_options.contains(&arg.as_str()) {
            let value = args
                .get(index + 1)
                .ok_or_else(|| CoreError::Validation(format!("missing value for {arg}")))?;
            if value.starts_with('-') {
                return Err(CoreError::Validation(format!(
                    "invalid option value for {arg}"
                )));
            }
            index += 1;
        }
        index += 1;
    }
    Ok(())
}

fn base_argv(agent: AgentType, install: &AdapterInstall) -> Vec<String> {
    let mut argv = vec![install.executable_path.clone()];
    if agent == AgentType::KiroCli {
        argv.push("chat".into());
    }
    if agent == AgentType::Cline && has(install, "tui") {
        argv.push("--tui".into());
    }
    argv
}

fn notices(agent: AgentType, mode: PermissionMode) -> Vec<LaunchNotice> {
    let mut result = vec![LaunchNotice::new(
        "extended_hooks_degraded",
        format!("{} uses PTY status heuristics; no verified per-session hook integration is enabled. Native CLI settings are unchanged.", agent.display_name()),
    )];
    if agent == AgentType::Amp {
        result.push(LaunchNotice::new(
            "amp_native_no_approval",
            "Amp's current native behavior does not ask for tool approval. AgentPort does not add or change Amp permission plugins.",
        ));
    }
    if agent == AgentType::Cline && mode == PermissionMode::Native {
        result.push(LaunchNotice::new(
            "cline_native_auto_approve",
            "Cline's current CLI defaults to auto-approve=true. Native mode preserves the CLI default; it does not guarantee manual approval prompts.",
        ));
    }
    result
}

fn plan(agent: AgentType, mode: PermissionMode, install: &AdapterInstall) -> LaunchPlan {
    LaunchPlan {
        argv: base_argv(agent, install),
        env: vec![],
        assigned_agent_session_id: None,
        resume_precision: ResumePrecision::Unavailable,
        hook_status: HookStatus::Degraded,
        transport: AgentTransport::Pty,
        helper_files: vec![],
        notices: notices(agent, mode),
    }
}

fn validate_context(
    agent: AgentType,
    install: &AdapterInstall,
    transport: AgentTransport,
) -> Result<()> {
    if install.agent_type != agent {
        return Err(CoreError::Validation(
            "adapter installation belongs to a different Agent".into(),
        ));
    }
    if transport != AgentTransport::Pty {
        return Err(CoreError::Blocked(format!(
            "{} only supports PTY transport in AgentPort",
            agent.display_name()
        )));
    }
    Ok(())
}

/// IDs are one argv element, but option-looking values and ambiguous special
/// identifiers must not be allowed to silently select another conversation.
fn validate_id(agent: AgentType, id: &str) -> Result<()> {
    let invalid =
        id.is_empty() || id.starts_with('-') || id.chars().any(char::is_control) || id.trim() != id;
    let valid_shape = match agent {
        AgentType::Gemini | AgentType::GrokBuild => uuid::Uuid::parse_str(id).is_ok(),
        AgentType::Amp => id
            .strip_prefix("T-")
            .is_some_and(|tail| uuid::Uuid::parse_str(tail).is_ok()),
        AgentType::Opencode => id
            .strip_prefix("ses_")
            .is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric())),
        // Cursor and Kiro do not promise that every future native ID is a UUID.
        // Reject cursor's sentinel -1 through the common check above.
        _ => id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
    };
    if invalid || !valid_shape {
        return Err(CoreError::Blocked(format!(
            "invalid {} native session ID; refusing ambiguous recovery",
            agent.display_name()
        )));
    }
    Ok(())
}

impl AgentAdapter for ExtendedAdapter {
    fn agent_type(&self) -> AgentType {
        self.0
    }

    fn parse_capabilities(
        &self,
        exe: &Path,
        version_out: &str,
        help_out: &str,
    ) -> Result<AdapterInstall> {
        if exact_flag(self.0).is_none() {
            return Err(CoreError::Validation("not an extended Agent type".into()));
        }
        // Both names are common outside their intended products. A resolved
        // executable path is not evidence that it is the requested coding CLI.
        if self.0 == AgentType::GrokBuild && !help_out.contains("Grok Build") {
            return Err(CoreError::Adapter(
                "grok executable did not identify itself as Grok Build; refusing a same-name CLI"
                    .into(),
            ));
        }
        if self.0 == AgentType::CursorAgent && !help_out.to_ascii_lowercase().contains("cursor") {
            return Err(CoreError::Adapter(
                "agent executable did not identify itself as Cursor CLI".into(),
            ));
        }
        let mut flags = super::extract_flags(help_out);
        if self.0 == AgentType::Amp
            && help_out.lines().any(|line| {
                let line = line.trim().to_ascii_lowercase();
                (line.starts_with("usage:") || line.starts_with("amp threads continue"))
                    && line.contains("amp threads continue")
            })
        {
            flags.push(AMP_CONTINUE_CAPABILITY.into());
            flags.sort();
            flags.dedup();
        }
        let exact_resume = exact_flag(self.0).is_some_and(|flag| flags.iter().any(|f| f == flag));
        Ok(AdapterInstall {
            agent_type: self.0,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            exact_resume,
            hook_status: HookStatus::Degraded,
            approval_model: self.0.approval_model(),
            default_transport: AgentTransport::Pty,
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags,
        })
    }

    fn build_launch(&self, ctx: &LaunchContext) -> Result<LaunchPlan> {
        validate_context(self.0, &ctx.install, ctx.transport)?;
        validate_advanced_args(self.0, &ctx.preset.args)?;
        let mut result = plan(self.0, ctx.preset.permission_mode, &ctx.install);
        if self.0 == AgentType::GrokBuild
            && has(&ctx.install, "session-id")
            && has(&ctx.install, "resume")
        {
            let id = uuid::Uuid::new_v4().to_string();
            result.argv.extend(["--session-id".into(), id.clone()]);
            result.assigned_agent_session_id = Some(id);
            result.resume_precision = ResumePrecision::Exact;
        } else if latest_args(self.0, &ctx.install).is_some() {
            result.resume_precision = ResumePrecision::Latest;
        }
        if result.resume_precision == ResumePrecision::Unavailable {
            result.notices.push(LaunchNotice::new(
                "extended_resume_unavailable",
                "Automatic conversation recovery is unavailable until a verified native session ID is captured. Reconnecting a running AgentPort terminal remains available.",
            ));
        }
        result.argv.extend(ctx.preset.args.clone());
        result.argv.extend(permission_args(
            self.0,
            ctx.preset.permission_mode,
            &ctx.install,
        )?);
        Ok(result)
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        validate_context(self.0, &ctx.install, ctx.transport)?;
        validate_advanced_args(self.0, &ctx.preset.args)?;
        let mut result = plan(self.0, ctx.permission_mode, &ctx.install);
        match &ctx.agent_session_id {
            Some(id) => {
                validate_id(self.0, id)?;
                let flag = exact_flag(self.0)
                    .ok_or_else(|| CoreError::Blocked("native recovery is unsupported".into()))?;
                if !has(&ctx.install, flag) {
                    return Err(CoreError::Blocked(format!("{} cannot resume the recorded native ID with this CLI version; refusing to start a different conversation", self.0.display_name())));
                }
                if self.0 == AgentType::Amp {
                    result
                        .argv
                        .extend(["threads".into(), "continue".into(), id.clone()]);
                } else {
                    result.argv.extend([format!("--{flag}"), id.clone()]);
                }
                result.resume_precision = ResumePrecision::Exact;
            }
            None => {
                let args = latest_args(self.0, &ctx.install).ok_or_else(|| CoreError::Blocked(format!("{} has no captured native session ID and no verified latest-session recovery; the original conversation cannot be recovered automatically", self.0.display_name())))?;
                result.argv.extend(args);
                result.resume_precision = ResumePrecision::Latest;
                result.notices.push(LaunchNotice::new(
                    "resume_latest_only",
                    "No native session ID was captured. The CLI will select its latest session; this may not be the original AgentPort conversation.",
                ));
            }
        }
        result.argv.extend(ctx.preset.args.clone());
        // Resume uses the persisted Session mode, not an edited preset's mode.
        result
            .argv
            .extend(permission_args(self.0, ctx.permission_mode, &ctx.install)?);
        Ok(result)
    }

    fn extract_session_id(&self, tail: &str) -> Option<String> {
        if self.0 != AgentType::KiroCli {
            return None;
        }
        // Official Kiro session-management docs specify the exit resume hint.
        // Do not parse generic UUIDs, titles, or arbitrary conversation URLs.
        let re =
            regex::Regex::new(r"(?m)^\s*kiro-cli chat --resume-id ([A-Za-z0-9_-]+)\s*$").ok()?;
        re.captures_iter(tail)
            .last()
            .map(|capture| capture[1].to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::test_fixtures as fx;

    const AGENTS: &[AgentType] = &[
        AgentType::Opencode,
        AgentType::Amp,
        AgentType::Gemini,
        AgentType::Cline,
        AgentType::KiroCli,
        AgentType::CursorAgent,
        AgentType::GrokBuild,
    ];
    const UUID: &str = "550e8400-e29b-41d4-a716-446655440000";

    fn install(agent: AgentType) -> AdapterInstall {
        ExtendedAdapter(agent)
            .parse_capabilities(
                Path::new(&format!("/fake/{}", agent.as_str())),
                "reference fixture, not an installed version",
                &fx::read_fixture(&format!("extended-{}-help-reference.txt", agent.as_str())),
            )
            .unwrap()
    }

    fn launch(agent: AgentType) -> LaunchContext {
        let mut ctx = fx::launch_ctx(agent, &[], PermissionMode::Native);
        ctx.install = install(agent);
        ctx
    }

    fn resume(agent: AgentType, id: Option<&str>) -> ResumeContext {
        let mut ctx = fx::resume_ctx(agent, &[], id);
        ctx.install = install(agent);
        ctx
    }

    fn native_id(agent: AgentType) -> String {
        match agent {
            AgentType::Opencode => "ses_abcd1234".into(),
            AgentType::Amp => format!("T-{UUID}"),
            _ => UUID.into(),
        }
    }

    #[test]
    fn every_reference_parses_and_launches_without_approval_override() {
        for &agent in AGENTS {
            let ctx = launch(agent);
            assert!(ctx.install.exact_resume, "{}", agent.as_str());
            let plan = ExtendedAdapter(agent).build_launch(&ctx).unwrap();
            assert_eq!(plan.argv[0], ctx.install.executable_path);
            assert_eq!(plan.transport, AgentTransport::Pty);
            assert_eq!(plan.hook_status, HookStatus::Degraded);
            assert!(plan.helper_files.is_empty());
            assert!(plan.env.is_empty());
            for forbidden in [
                "--auto",
                "--yolo",
                "--force",
                "--trust-all-tools",
                "--permission-mode",
                "--auto-approve",
                "--approval-mode",
            ] {
                assert!(
                    !plan.argv.iter().any(|arg| arg == forbidden),
                    "{agent:?}: {forbidden}"
                );
            }
            if agent == AgentType::KiroCli {
                assert_eq!(plan.argv[1], "chat");
            }
            if agent == AgentType::Cline {
                assert_eq!(plan.argv[1], "--tui");
            }
        }
    }

    #[test]
    fn every_adapter_resumes_the_exact_recorded_id() {
        for &agent in AGENTS {
            let id = native_id(agent);
            let result = ExtendedAdapter(agent)
                .build_resume(&resume(agent, Some(&id)))
                .unwrap();
            assert_eq!(result.resume_precision, ResumePrecision::Exact);
            assert!(result.argv.contains(&id));
            assert!(!result.argv.iter().any(|arg| arg == "--continue"));
            if agent == AgentType::Amp {
                assert_eq!(&result.argv[1..3], &["threads", "continue"]);
            }
            if agent == AgentType::KiroCli {
                assert_eq!(result.argv[2], "--resume-id");
            }
            if agent == AgentType::Cline {
                assert!(result.argv.contains(&"--id".into()));
            }
        }
    }

    #[test]
    fn missing_id_is_latest_only_or_blocked_never_an_empty_new_chat() {
        for &agent in AGENTS {
            let result = ExtendedAdapter(agent).build_resume(&resume(agent, None));
            if matches!(agent, AgentType::Amp | AgentType::Cline) {
                assert!(matches!(result, Err(CoreError::Blocked(_))));
            } else {
                let plan = result.unwrap();
                assert_eq!(plan.resume_precision, ResumePrecision::Latest);
                assert!(plan
                    .notices
                    .iter()
                    .any(|notice| notice.code == "resume_latest_only"));
                if agent == AgentType::Gemini {
                    assert!(plan.argv.contains(&"latest".into()));
                }
                if agent == AgentType::KiroCli {
                    assert_eq!(&plan.argv[1..], &["chat", "--resume"]);
                }
            }
        }
    }

    #[test]
    fn missing_resume_flags_never_downgrade_a_recorded_id() {
        for &agent in AGENTS {
            let id = native_id(agent);
            let mut ctx = resume(agent, Some(&id));
            ctx.install.flags.clear();
            // A stale boolean alone cannot authorize passing an unknown flag.
            ctx.install.exact_resume = true;
            assert!(matches!(
                ExtendedAdapter(agent).build_resume(&ctx),
                Err(CoreError::Blocked(_))
            ));
            ctx.agent_session_id = None;
            assert!(matches!(
                ExtendedAdapter(agent).build_resume(&ctx),
                Err(CoreError::Blocked(_))
            ));
        }
    }

    #[test]
    fn permission_matrix_requires_probed_flags_and_native_is_always_empty() {
        for &agent in AGENTS {
            let full = install(agent);
            let mut absent = full.clone();
            absent.flags.clear();
            assert!(permission_args(agent, PermissionMode::Native, &absent)
                .unwrap()
                .is_empty());
            for mode in [PermissionMode::Auto, PermissionMode::Bypass] {
                assert!(
                    permission_args(agent, mode, &absent).is_err(),
                    "{agent:?} {mode:?}"
                );
                let supported = agent != AgentType::Amp
                    && !(agent == AgentType::Opencode && mode == PermissionMode::Bypass);
                assert_eq!(
                    permission_args(agent, mode, &full).is_ok(),
                    supported,
                    "{agent:?} {mode:?}"
                );
            }
        }
        assert_eq!(
            permission_args(
                AgentType::Gemini,
                PermissionMode::Auto,
                &install(AgentType::Gemini)
            )
            .unwrap(),
            ["--approval-mode", "auto_edit"]
        );
        assert_eq!(
            permission_args(
                AgentType::GrokBuild,
                PermissionMode::Auto,
                &install(AgentType::GrokBuild)
            )
            .unwrap(),
            ["--permission-mode", "acceptEdits"]
        );
    }

    #[test]
    fn resume_preserves_session_mode_over_changed_preset() {
        for &agent in AGENTS {
            let id = native_id(agent);
            let mut ctx = resume(agent, Some(&id));
            ctx.preset.permission_mode = PermissionMode::Bypass;
            ctx.permission_mode = PermissionMode::Native;
            let result = ExtendedAdapter(agent).build_resume(&ctx).unwrap();
            assert!(!result.argv.contains(&"--force".into()));
            assert!(!result.argv.contains(&"--permission-mode".into()));
            assert!(!result.argv.contains(&"--auto-approve".into()));
        }
    }

    #[test]
    fn grok_assigns_a_new_uuid_only_when_launch_and_resume_flags_are_known() {
        let adapter = ExtendedAdapter(AgentType::GrokBuild);
        let mut ctx = launch(AgentType::GrokBuild);
        let result = adapter.build_launch(&ctx).unwrap();
        let id = result.assigned_agent_session_id.unwrap();
        assert!(uuid::Uuid::parse_str(&id).is_ok());
        assert_eq!(result.resume_precision, ResumePrecision::Exact);
        assert!(result.argv.contains(&id));
        ctx.install.flags.retain(|f| f != "session-id");
        let result = adapter.build_launch(&ctx).unwrap();
        assert!(result.assigned_agent_session_id.is_none());
        assert_eq!(result.resume_precision, ResumePrecision::Latest);
    }

    #[test]
    fn native_auto_approval_is_disclosed_not_represented_as_manual_prompts() {
        let amp = ExtendedAdapter(AgentType::Amp)
            .build_launch(&launch(AgentType::Amp))
            .unwrap();
        assert!(amp
            .notices
            .iter()
            .any(|n| n.code == "amp_native_no_approval"));
        let cline = ExtendedAdapter(AgentType::Cline)
            .build_launch(&launch(AgentType::Cline))
            .unwrap();
        assert!(cline
            .notices
            .iter()
            .any(|n| n.code == "cline_native_auto_approve"));
    }

    #[test]
    fn managed_args_reject_long_equal_short_attached_and_subcommands() {
        for &agent in AGENTS {
            for &arg in protected_args(agent) {
                let mut ctx = launch(agent);
                ctx.preset.args = vec![format!("{arg}=value")];
                assert!(
                    ExtendedAdapter(agent).build_launch(&ctx).is_err(),
                    "{agent:?}: {arg}"
                );
                if arg.len() == 2 {
                    ctx.preset.args = vec![format!("{arg}value")];
                    assert!(ExtendedAdapter(agent).build_launch(&ctx).is_err());
                }
            }
            for args in [
                vec!["logout".into()],
                vec!["--".into(), "logout".into()],
                vec!["--model".into(), "custom".into(), "logout".into()],
                vec!["--debug".into(), "logout".into()],
            ] {
                let mut ctx = launch(agent);
                ctx.preset.args = args;
                assert!(ExtendedAdapter(agent).build_launch(&ctx).is_err());
            }
            let mut ctx = launch(agent);
            ctx.preset.args = vec!["--model".into(), "provider/model".into()];
            assert!(ExtendedAdapter(agent).build_launch(&ctx).is_ok());
        }
    }

    #[test]
    fn ambiguous_ids_and_wrong_transport_are_rejected() {
        for &agent in AGENTS {
            for id in ["", "-1", "--continue", "id\nother", " id "] {
                assert!(ExtendedAdapter(agent)
                    .build_resume(&resume(agent, Some(id)))
                    .is_err());
            }
            let mut ctx = launch(agent);
            ctx.transport = AgentTransport::JsonRpc;
            assert!(ExtendedAdapter(agent).build_launch(&ctx).is_err());
            ctx.transport = AgentTransport::Pty;
            ctx.install.agent_type = AgentType::Shell;
            assert!(ExtendedAdapter(agent).build_launch(&ctx).is_err());
        }
        for agent in [AgentType::Gemini, AgentType::GrokBuild] {
            for id in ["latest", "1", "my-session-title"] {
                assert!(ExtendedAdapter(agent)
                    .build_resume(&resume(agent, Some(id)))
                    .is_err());
            }
        }
    }

    #[test]
    fn same_named_executables_and_unproven_subcommands_do_not_count_as_capabilities() {
        for agent in [AgentType::GrokBuild, AgentType::CursorAgent] {
            assert!(ExtendedAdapter(agent)
                .parse_capabilities(
                    Path::new("/bin/agent"),
                    "1.0",
                    "Usage: other tool --resume --session-id"
                )
                .is_err());
        }
        let amp = ExtendedAdapter(AgentType::Amp)
            .parse_capabilities(
                Path::new("/bin/amp"),
                "future",
                "Amp CLI\n--help\nthreads Manage threads",
            )
            .unwrap();
        assert!(!amp.exact_resume);
        for &agent in AGENTS {
            let help = match agent {
                AgentType::GrokBuild => "Grok Build TUI --help",
                AgentType::CursorAgent => "Cursor Agent --help",
                _ => "--help",
            };
            let parsed = ExtendedAdapter(agent)
                .parse_capabilities(Path::new("/bin/tool"), "future", help)
                .unwrap();
            assert!(!parsed.exact_resume);
        }
    }

    #[test]
    fn kiro_id_capture_requires_the_explicit_resume_command() {
        let kiro = ExtendedAdapter(AgentType::KiroCli);
        assert_eq!(
            kiro.extract_session_id("Goodbye\nkiro-cli chat --resume-id abc123-def456\n"),
            Some("abc123-def456".into())
        );
        assert_eq!(kiro.extract_session_id("Session: abc123-def456"), None);
        assert_eq!(
            kiro.extract_session_id("Try kiro-cli chat --resume-id abc123-def456"),
            None
        );
        for &agent in AGENTS {
            if agent != AgentType::KiroCli {
                assert_eq!(ExtendedAdapter(agent).extract_session_id(UUID), None);
            }
        }
    }
}
