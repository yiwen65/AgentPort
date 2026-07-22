//! Codex adapter. Verified on this machine against codex-cli 0.144.5
//! (fixtures in tests/fixtures/cli/):
//! - `codex resume [SESSION_ID]` : exact resume by UUID (or name).
//! - `codex resume --last`       : latest session for this cwd (precision = latest).
//! - `-c key=value`              : per-invocation config override (confirmed in --help).
//!   The `notify` config key is NOT mentioned anywhere in 0.144.5's
//!   --help/doctor/debug output, so we do NOT inject `-c notify=...`: hook
//!   injection is unverifiable on this version -> HookStatus::Degraded, PTY
//!   heuristics carry status (never edits ~/.codex/config.toml either way).
//! - Session-id capture: `codex exec --json` emits
//!   `{"type":"thread.started","thread_id":"<uuid>"}` (verified 2026-07-18,
//!   fixture codex-exec-ok.txt). Whether the interactive TUI prints the id is
//!   unverified, so launch precision stays Latest; extract_session_id still
//!   recognizes the thread.started line when it appears (e.g. exec in PTY).
//! - Approval flags on 0.144.5 (verified): `-a, --ask-for-approval
//!   <untrusted|on-request|never>` and `--dangerously-bypass-approvals-and-sandbox`.
//!   `--full-auto` does NOT exist on this version. Only flags proven present in
//!   parsed --help output are ever used.

use super::{AgentAdapter, LaunchContext, LaunchPlan, ResumeContext};
use crate::error::{CoreError, Result};
use crate::models::*;
use std::path::Path;

pub struct CodexAdapter;

impl AgentAdapter for CodexAdapter {
    fn agent_type(&self) -> AgentType {
        AgentType::Codex
    }

    fn parse_capabilities(
        &self,
        exe: &Path,
        version_out: &str,
        help_out: &str,
    ) -> Result<AdapterInstall> {
        // help_out = `codex --help` + `codex resume --help` (merged by the prober).
        let flags = super::extract_flags(help_out);
        // Exact resume iff the resume subcommand accepts a SESSION_ID argument.
        let exact_resume = help_out.contains("[SESSION_ID]")
            || (help_out.contains("resume") && help_out.contains("SESSION_ID"));
        Ok(AdapterInstall {
            agent_type: AgentType::Codex,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            exact_resume,
            // notify key unverifiable from CLI output on 0.144.5 -> degraded.
            hook_status: HookStatus::Degraded,
            approval_model: AgentType::Codex.approval_model(),
            default_transport: AgentType::Codex.default_transport(),
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags,
        })
    }

    fn build_launch(&self, ctx: &LaunchContext) -> Result<LaunchPlan> {
        let install = &ctx.install;
        let mut argv = vec![install.executable_path.clone()];
        argv.extend(ctx.preset.args.clone());
        argv.extend(super::permission_argv(
            AgentType::Codex,
            ctx.preset.permission_mode,
            install,
        )?);
        Ok(LaunchPlan {
            argv,
            env: vec![],
            // TUI session id unverified -> cannot assign; capture best-effort.
            assigned_agent_session_id: None,
            resume_precision: ResumePrecision::Latest,
            hook_status: install.hook_status,
            transport: ctx.transport,
            helper_files: vec![],
            notes: vec![
                "codex 0.144.5 的 help/doctor 未出现 notify 配置键，hook 注入不可验证，降级为 PTY 启发式".into(),
                "TUI 模式未证实输出会话 ID，仅支持恢复最近会话（resume --last）".into(),
            ],
        })
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        let install = &ctx.install;
        let mut argv = vec![install.executable_path.clone()];
        let mut notes = Vec::new();
        let resume_precision = match &ctx.agent_session_id {
            Some(id) => {
                if !install.exact_resume {
                    return Err(CoreError::Blocked(
                        "该版本 codex 的 resume 子命令不接受 SESSION_ID，无法精确恢复".into(),
                    ));
                }
                argv.push("resume".into());
                argv.push(id.clone());
                ResumePrecision::Exact
            }
            None => {
                argv.push("resume".into());
                argv.push("--last".into());
                notes.push("无原生会话 ID，仅支持恢复最近会话".into());
                ResumePrecision::Latest
            }
        };
        argv.extend(ctx.preset.args.clone());
        argv.extend(super::permission_argv(
            AgentType::Codex,
            ctx.preset.permission_mode,
            install,
        )?);
        Ok(LaunchPlan {
            argv,
            env: vec![],
            assigned_agent_session_id: None,
            resume_precision,
            hook_status: install.hook_status,
            transport: ctx.transport,
            helper_files: vec![],
            notes,
        })
    }

    fn extract_session_id(&self, stripped_text_tail: &str) -> Option<String> {
        // Evidence: codex exec --json line
        // {"type":"thread.started","thread_id":"019f779d-efd0-76a2-a39e-eb95459089a0"}
        let re = regex::Regex::new(
            r#""type"\s*:\s*"thread\.started"[^\n]*?"thread_id"\s*:\s*"([0-9a-fA-F-]{36})""#,
        )
        .unwrap();
        re.captures(stripped_text_tail).map(|c| c[1].to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::test_fixtures as fx;

    fn merged_help() -> String {
        // 探针会合并 `codex --help` 与 `codex resume --help`
        format!(
            "{}\n{}",
            fx::read_fixture("codex-help.txt"),
            fx::read_fixture("codex-resume-help.txt")
        )
    }

    fn real_install() -> AdapterInstall {
        CodexAdapter
            .parse_capabilities(
                Path::new("/Users/w/.local/bin/codex"),
                &fx::read_fixture("codex-version.txt"),
                &merged_help(),
            )
            .unwrap()
    }

    #[test]
    fn parse_real_fixtures() {
        let i = real_install();
        assert_eq!(i.version_text, "codex-cli 0.144.5");
        for f in [
            "config",
            "ask-for-approval",
            "dangerously-bypass-approvals-and-sandbox",
            "last",
        ] {
            assert!(i.flags.iter().any(|x| x == f), "missing flag {f}");
        }
        // 0.144.5 无 --full-auto
        assert!(!i.flags.iter().any(|x| x == "full-auto"));
        assert!(i.exact_resume);
        // notify 无法从 help 确认 -> hook 降级
        assert_eq!(i.hook_status, HookStatus::Degraded);
    }

    #[test]
    fn parse_unknown_future_version_degrades() {
        // 去掉 resume 子命令的 SESSION_ID 参数
        let help = merged_help()
            .replace("[SESSION_ID]", "")
            .replace("SESSION_ID", "SID");
        let i = CodexAdapter
            .parse_capabilities(Path::new("/x/codex"), "codex-cli 99.0", &help)
            .unwrap();
        assert!(!i.exact_resume);
    }

    #[test]
    fn extract_session_id_from_real_exec_jsonl() {
        let out = fx::read_fixture("codex-exec-ok.txt");
        let id = CodexAdapter.extract_session_id(&out);
        assert_eq!(id.as_deref(), Some("019f779d-efd0-76a2-a39e-eb95459089a0"));
        assert_eq!(CodexAdapter.extract_session_id("no id here"), None);
    }

    #[test]
    fn build_launch_no_notify_injection() {
        let mut ctx = fx::launch_ctx(
            AgentType::Codex,
            &["ask-for-approval"],
            PermissionMode::Auto,
        );
        ctx.install.hook_status = HookStatus::Degraded; // 与真实探测结果一致
        let plan = CodexAdapter.build_launch(&ctx).unwrap();
        assert_eq!(plan.argv[1..], ["--ask-for-approval", "never"]);
        assert!(!plan.argv.iter().any(|a| a.contains("notify")));
        assert_eq!(plan.hook_status, HookStatus::Degraded);
        assert_eq!(plan.resume_precision, ResumePrecision::Latest);
        assert!(plan.helper_files.is_empty());
    }

    #[test]
    fn build_resume_exact_latest() {
        let ctx = fx::resume_ctx(AgentType::Codex, &[], Some("uuid-9"));
        let plan = CodexAdapter.build_resume(&ctx).unwrap();
        assert_eq!(plan.resume_precision, ResumePrecision::Exact);
        assert_eq!(plan.argv[1..], ["resume", "uuid-9"]);

        let ctx = fx::resume_ctx(AgentType::Codex, &[], None);
        let plan = CodexAdapter.build_resume(&ctx).unwrap();
        assert_eq!(plan.resume_precision, ResumePrecision::Latest);
        assert_eq!(plan.argv[1..], ["resume", "--last"]);
        assert!(plan.notes.iter().any(|n| n.contains("最近会话")));
    }
}
