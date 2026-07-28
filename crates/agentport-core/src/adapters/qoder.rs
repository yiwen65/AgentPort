//! Qoder CLI adapter.
//!
//! AgentPort owns the working directory, native session id, permission mode,
//! and temporary hook settings.  It never writes Qoder's user/project config.

use super::{AgentAdapter, LaunchContext, LaunchNotice, LaunchPlan, ResumeContext};
use crate::error::{CoreError, Result};
use crate::models::*;
use std::path::Path;

pub struct QoderAdapter;

const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "SessionEnd",
];

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The relay deliberately discards Qoder's hook payload.  Tool input and
/// output can contain credentials, and AgentPort only needs the event name
/// and native session identity for state correlation.
fn relay_script() -> String {
    r#"#!/bin/sh
cat >/dev/null
printf '{"event":"%s","agentport_session_id":"%s"}\n' "$1" "$2" >> "$3"
"#
    .into()
}

fn settings_json(relay_path: &str, session_id: &str, events_path: &str) -> String {
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        let command = format!(
            "sh {} {} {} {}",
            shell_quote(relay_path),
            shell_quote(event),
            shell_quote(session_id),
            shell_quote(events_path),
        );
        hooks.insert(
            (*event).to_string(),
            serde_json::json!([{"hooks": [{"type": "command", "command": command}]}]),
        );
    }
    serde_json::to_string_pretty(&serde_json::json!({"hooks": hooks}))
        .unwrap_or_else(|_| "{}".into())
}

fn hook_files(ctx: &LaunchContext) -> (Vec<(String, String)>, Option<String>) {
    let relay = format!("{}/qoder-hook-relay.sh", ctx.session_dir);
    let settings = format!("{}/qoder-settings.json", ctx.session_dir);
    (
        vec![
            (relay.clone(), relay_script()),
            (
                settings.clone(),
                settings_json(&relay, &ctx.session_id, &ctx.hook_events_path),
            ),
        ],
        Some(settings),
    )
}

fn hook_plan(
    install: &AdapterInstall,
    ctx: &LaunchContext,
    argv: &mut Vec<String>,
    notices: &mut Vec<LaunchNotice>,
) -> (HookStatus, Vec<(String, String)>) {
    if !super::has_flag(install, "settings") {
        notices.push(LaunchNotice::new(
            "hook_settings_unavailable",
            "该版本无 --settings，Qoder Hook 降级为 PTY 启发式",
        ));
        return (HookStatus::Degraded, vec![]);
    }
    let (files, settings) = hook_files(ctx);
    argv.push("--settings".into());
    argv.push(settings.expect("settings path is always present"));
    (HookStatus::Supported, files)
}

impl AgentAdapter for QoderAdapter {
    fn agent_type(&self) -> AgentType {
        AgentType::Qoder
    }

    fn parse_capabilities(
        &self,
        exe: &Path,
        version_out: &str,
        help_out: &str,
    ) -> Result<AdapterInstall> {
        let flags = super::extract_flags(help_out);
        let has = |flag: &str| flags.iter().any(|value| value == flag);
        Ok(AdapterInstall {
            agent_type: AgentType::Qoder,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            exact_resume: has("session-id"),
            hook_status: if has("settings") {
                HookStatus::Supported
            } else {
                HookStatus::Degraded
            },
            approval_model: AgentType::Qoder.approval_model(),
            default_transport: AgentType::Qoder.default_transport(),
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags,
        })
    }

    fn build_launch(&self, ctx: &LaunchContext) -> Result<LaunchPlan> {
        let install = &ctx.install;
        if !super::has_flag(install, "session-id") {
            return Err(CoreError::Blocked(
                "this version of qodercli has no --session-id flag and cannot satisfy exact-resume requirements".into(),
            ));
        }
        let mut argv = vec![install.executable_path.clone()];
        let mut notices = vec![];
        let (hook_status, helper_files) = hook_plan(install, ctx, &mut argv, &mut notices);
        let native_id = crate::ids::new_uuid();
        argv.extend(["--session-id".into(), native_id.clone()]);
        argv.extend(ctx.preset.args.clone());
        argv.extend(super::permission_argv(
            AgentType::Qoder,
            ctx.preset.permission_mode,
            install,
        )?);
        Ok(LaunchPlan {
            argv,
            env: vec![],
            assigned_agent_session_id: Some(native_id),
            resume_precision: ResumePrecision::Exact,
            hook_status,
            transport: AgentTransport::Pty,
            helper_files,
            notices,
        })
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        let install = &ctx.install;
        let mut argv = vec![install.executable_path.clone()];
        let mut notices = vec![];
        let (resume_precision, helper_files, hook_status) = match &ctx.agent_session_id {
            Some(id) => {
                if !super::has_flag(install, "session-id") {
                    return Err(CoreError::Blocked(
                        "this version of qodercli has no --session-id flag and cannot resume a Session exactly".into(),
                    ));
                }
                // Qoder's --resume opens the chat-session picker. Supplying
                // the native ID directly reopens an existing transcript and,
                // when the initial turn was interrupted before persistence,
                // returns to the interactive input instead of the picker.
                argv.extend(["--session-id".into(), id.clone()]);
                let launch_ctx = LaunchContext {
                    transport: AgentTransport::Pty,
                    ..ctx.to_launch_context()
                };
                let (status, files) = hook_plan(install, &launch_ctx, &mut argv, &mut notices);
                (ResumePrecision::Exact, files, status)
            }
            None => {
                if !super::has_flag(install, "continue") {
                    return Err(CoreError::Blocked(
                        "no native Session ID is available and this version of qodercli has no --continue flag".into(),
                    ));
                }
                argv.push("--continue".into());
                notices.push(LaunchNotice::new(
                    "resume_latest_only",
                    "无原生 Session ID，仅支持恢复最近的 Session",
                ));
                (ResumePrecision::Latest, vec![], HookStatus::Degraded)
            }
        };
        argv.extend(ctx.preset.args.clone());
        argv.extend(super::permission_argv(
            AgentType::Qoder,
            ctx.permission_mode,
            install,
        )?);
        Ok(LaunchPlan {
            argv,
            env: vec![],
            // Keep the native Qoder ID as a Host hint. Hooks intentionally
            // carry only AgentPort's Session ID and must never overwrite it.
            assigned_agent_session_id: ctx.agent_session_id.clone(),
            resume_precision,
            hook_status,
            transport: AgentTransport::Pty,
            helper_files,
            notices,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::test_fixtures as fx;

    #[test]
    fn qoder_native_launch_does_not_require_the_full_access_flag() {
        let install = fx::install(
            AgentType::Qoder,
            &["session-id", "resume", "continue", "settings"],
        );
        let mut ctx = fx::launch_ctx(AgentType::Qoder, &[], PermissionMode::Native);
        ctx.install = install;
        let plan = QoderAdapter.build_launch(&ctx).unwrap();
        assert!(!plan
            .argv
            .iter()
            .any(|value| value == "--dangerously-skip-permissions"));
    }

    #[test]
    fn qoder_launch_owns_session_and_hooks() {
        let mut ctx = fx::launch_ctx(
            AgentType::Qoder,
            &[
                "session-id",
                "resume",
                "continue",
                "settings",
                "dangerously-skip-permissions",
            ],
            PermissionMode::Bypass,
        );
        ctx.transport = AgentTransport::Pty;
        let plan = QoderAdapter.build_launch(&ctx).unwrap();
        assert!(plan.argv.iter().any(|value| value == "--session-id"));
        assert!(plan
            .argv
            .iter()
            .any(|value| value == "--dangerously-skip-permissions"));
        assert_eq!(plan.hook_status, HookStatus::Supported);
        assert_eq!(plan.helper_files.len(), 2);
        assert!(plan
            .helper_files
            .iter()
            .all(|(_, contents)| !contents.contains("\"session_id\"")));
    }

    #[test]
    fn qoder_resume_reopens_native_id_without_session_picker() {
        let mut ctx = fx::resume_ctx(
            AgentType::Qoder,
            &["session-id", "settings", "dangerously-skip-permissions"],
            Some("qoder-native-id"),
        );
        ctx.preset.permission_mode = PermissionMode::Bypass;
        let plan = QoderAdapter.build_resume(&ctx).unwrap();
        assert!(plan
            .argv
            .windows(2)
            .any(|pair| pair == ["--session-id", "qoder-native-id"]));
        assert!(!plan.argv.iter().any(|value| value == "--resume"));
        assert_eq!(
            plan.assigned_agent_session_id.as_deref(),
            Some("qoder-native-id")
        );
    }

    #[test]
    fn qoder_parses_1_1_2_help_fixture() {
        let version = fx::read_fixture("qoder-1.1.2-version.txt");
        let help = fx::read_fixture("qoder-1.1.2-help.txt");
        let install = QoderAdapter
            .parse_capabilities(Path::new("/fake/qodercli"), &version, &help)
            .unwrap();
        assert_eq!(install.version_text, "1.1.2");
        assert!(install
            .flags
            .iter()
            .any(|flag| flag == "dangerously-skip-permissions"));
        assert!(install.flags.iter().any(|flag| flag == "settings"));
    }
}
