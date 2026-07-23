//! Pi coding-agent adapter.
//!
//! Pi has no tool-by-tool approval protocol.  AgentPort starts it with project
//! trust pre-approved as requested and owns its native Session ID and storage.

use super::{AgentAdapter, LaunchContext, LaunchPlan, ResumeContext};
use crate::error::{CoreError, Result};
use crate::models::*;
use std::path::Path;

pub struct PiAdapter;

fn session_dir(ctx: &LaunchContext) -> String {
    format!("{}/pi", ctx.session_dir)
}

fn managed_args(transport: AgentTransport, native_id: &str, dir: &str) -> Vec<String> {
    let mut args = Vec::new();
    if transport == AgentTransport::JsonRpc {
        args.extend(["--mode".into(), "rpc".into()]);
    }
    args.extend([
        "--session-id".into(),
        native_id.into(),
        "--session-dir".into(),
        dir.into(),
        "--approve".into(),
    ]);
    if transport == AgentTransport::JsonRpc {
        args.extend([
            "--no-extensions".into(),
            "--no-skills".into(),
            "--no-prompt-templates".into(),
            "--no-themes".into(),
        ]);
    }
    args
}

impl AgentAdapter for PiAdapter {
    fn agent_type(&self) -> AgentType {
        AgentType::Pi
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
            agent_type: AgentType::Pi,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            // Pi's --session-id opens an existing exact-ID session and creates
            // it when the first turn was interrupted before Pi persisted a
            // transcript. Requiring --session would make that empty-session
            // recovery fail with "No session found matching …".
            exact_resume: has("session-id") && has("session-dir"),
            hook_status: HookStatus::Unavailable,
            approval_model: AgentType::Pi.approval_model(),
            default_transport: AgentType::Pi.default_transport(),
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags,
        })
    }

    fn build_launch(&self, ctx: &LaunchContext) -> Result<LaunchPlan> {
        let install = &ctx.install;
        for flag in ["session-id", "session-dir", "approve"] {
            if !super::has_flag(install, flag) {
                return Err(CoreError::Blocked(format!(
                    "该版本 pi 无 --{flag}，无法满足 AgentPort 受管会话约束"
                )));
            }
        }
        if ctx.transport == AgentTransport::JsonRpc {
            for flag in [
                "mode",
                "no-extensions",
                "no-skills",
                "no-prompt-templates",
                "no-themes",
            ] {
                if !super::has_flag(install, flag) {
                    return Err(CoreError::Blocked(format!(
                        "该版本 pi 无 --{flag}，无法启动结构化 RPC 会话"
                    )));
                }
            }
        }
        let native_id = crate::ids::new_uuid();
        let dir = session_dir(ctx);
        let mut argv = vec![install.executable_path.clone()];
        argv.extend(managed_args(ctx.transport, &native_id, &dir));
        argv.extend(ctx.preset.args.clone());
        Ok(LaunchPlan {
            argv,
            env: vec![],
            assigned_agent_session_id: Some(native_id),
            resume_precision: ResumePrecision::Exact,
            hook_status: HookStatus::Unavailable,
            transport: ctx.transport,
            helper_files: vec![],
            notes: vec!["Pi 无逐项权限确认，将以本地用户权限执行".into()],
        })
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        let native_id = ctx
            .agent_session_id
            .as_ref()
            .ok_or_else(|| CoreError::Blocked("Pi 原生会话 ID 缺失，无法精确恢复".into()))?;
        let install = &ctx.install;
        for flag in ["session-id", "session-dir", "approve"] {
            if !super::has_flag(install, flag) {
                return Err(CoreError::Blocked(format!(
                    "该版本 pi 无 --{flag}，无法精确恢复会话"
                )));
            }
        }
        if ctx.transport == AgentTransport::JsonRpc {
            for flag in [
                "mode",
                "no-extensions",
                "no-skills",
                "no-prompt-templates",
                "no-themes",
            ] {
                if !super::has_flag(install, flag) {
                    return Err(CoreError::Blocked(format!(
                        "该版本 pi 无 --{flag}，无法恢复结构化 RPC 会话"
                    )));
                }
            }
        }
        let launch_ctx = LaunchContext {
            install: ctx.install.clone(),
            preset: ctx.preset.clone(),
            cwd: ctx.cwd.clone(),
            session_id: ctx.session_id.clone(),
            hook_events_path: ctx.hook_events_path.clone(),
            session_dir: ctx.session_dir.clone(),
            transport: ctx.transport,
        };
        let dir = session_dir(&launch_ctx);
        let mut argv = vec![install.executable_path.clone()];
        if ctx.transport == AgentTransport::JsonRpc {
            argv.extend(["--mode".into(), "rpc".into()]);
        }
        // Unlike --session, Pi's --session-id is idempotent: it reopens an
        // existing private transcript or recreates the same empty session
        // after a Ctrl-C before Pi's first assistant response flushed it.
        argv.extend([
            "--session-id".into(),
            native_id.clone(),
            "--session-dir".into(),
            dir,
            "--approve".into(),
        ]);
        if ctx.transport == AgentTransport::JsonRpc {
            argv.extend([
                "--no-extensions".into(),
                "--no-skills".into(),
                "--no-prompt-templates".into(),
                "--no-themes".into(),
            ]);
        }
        argv.extend(ctx.preset.args.clone());
        Ok(LaunchPlan {
            argv,
            env: vec![],
            // The native ID is retained for exact Pi resume. Structured RPC
            // compatibility sessions additionally validate it via get_state.
            assigned_agent_session_id: Some(native_id.clone()),
            resume_precision: ResumePrecision::Exact,
            hook_status: HookStatus::Unavailable,
            transport: ctx.transport,
            helper_files: vec![],
            notes: vec!["Pi 无逐项权限确认，将以本地用户权限执行".into()],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::test_fixtures as fx;

    #[test]
    fn pi_tui_launch_uses_private_storage_and_approval() {
        let ctx = fx::launch_ctx(
            AgentType::Pi,
            &["session-id", "session", "session-dir", "approve"],
            PermissionMode::Native,
        );
        let plan = PiAdapter.build_launch(&ctx).unwrap();
        assert!(!plan.argv.iter().any(|value| value == "--mode"));
        assert!(plan.argv.iter().any(|value| value == "--session-dir"));
        assert!(plan.argv.iter().any(|value| value == "--approve"));
        assert_eq!(plan.transport, AgentTransport::Pty);
    }

    #[test]
    fn pi_rpc_launch_uses_private_storage_and_approval() {
        let mut ctx = fx::launch_ctx(
            AgentType::Pi,
            &[
                "session-id",
                "session",
                "session-dir",
                "approve",
                "mode",
                "no-extensions",
                "no-skills",
                "no-prompt-templates",
                "no-themes",
            ],
            PermissionMode::Native,
        );
        ctx.transport = AgentTransport::JsonRpc;
        let plan = PiAdapter.build_launch(&ctx).unwrap();
        assert!(plan.argv.windows(2).any(|pair| pair == ["--mode", "rpc"]));
        assert!(plan.argv.iter().any(|value| value == "--session-dir"));
        assert!(plan.argv.iter().any(|value| value == "--approve"));
        assert_eq!(plan.transport, AgentTransport::JsonRpc);
    }

    #[test]
    fn pi_tui_resume_reuses_native_id_before_the_first_turn_is_persisted() {
        let ctx = fx::resume_ctx(
            AgentType::Pi,
            &["session-id", "session-dir", "approve"],
            Some("pi-native-id"),
        );
        let plan = PiAdapter.build_resume_checked(&ctx).unwrap();
        assert!(plan
            .argv
            .windows(2)
            .any(|pair| pair == ["--session-id", "pi-native-id"]));
        assert!(!plan.argv.iter().any(|value| value == "--session"));
        assert!(!plan.argv.iter().any(|value| value == "--mode"));
        assert_eq!(
            plan.assigned_agent_session_id.as_deref(),
            Some("pi-native-id")
        );
        assert_eq!(plan.transport, AgentTransport::Pty);
    }

    #[test]
    fn pi_parses_0_81_1_help_fixture() {
        let version = fx::read_fixture("pi-0.81.1-version.txt");
        let help = fx::read_fixture("pi-0.81.1-help.txt");
        let install = PiAdapter
            .parse_capabilities(Path::new("/fake/pi"), &version, &help)
            .unwrap();
        assert_eq!(install.version_text, "0.81.1");
        assert!(install.flags.iter().any(|flag| flag == "mode"));
        assert!(install.flags.iter().any(|flag| flag == "approve"));
    }
}
