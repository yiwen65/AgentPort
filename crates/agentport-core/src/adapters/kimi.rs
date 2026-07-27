//! Kimi Code adapter. Verified on this machine against kimi 0.29.0
//! (fixtures in tests/fixtures/cli/):
//! - `-S, --session [id]` : resume a session by id (EXACT when id known).
//! - `-c, --continue`     : continue previous session for cwd (precision = latest).
//! - `-y, --yolo` / `--auto` : auto-approve flags — NEVER added by default; only when
//!   the preset explicitly enables auto/bypass and preflight shows the risk.
//! - Only the `kimi` command is supported (not legacy kimi-cli python layout).
//! - Hooks: 0.29.0's --help shows NO per-invocation hook/config flag and no
//!   documented env mechanism. The only hook mechanism is the global
//!   ~/.kimi-code/config.toml, which we must NOT modify -> "no session-level
//!   mechanism", HookStatus::Degraded. Turn completion follows Kimi's official
//!   main-agent wire JSONL; approval prompts still rely on PTY heuristics.
//! - Session-id capture: prompt mode prints a resume command, while the
//!   interactive TUI header renders `Session: session_<uuid>`.

use super::{AgentAdapter, LaunchContext, LaunchNotice, LaunchPlan, ResumeContext};
use crate::error::{CoreError, Result};
use crate::models::*;
use std::path::Path;

pub struct KimiAdapter;

impl AgentAdapter for KimiAdapter {
    fn agent_type(&self) -> AgentType {
        AgentType::Kimi
    }

    fn parse_capabilities(
        &self,
        exe: &Path,
        version_out: &str,
        help_out: &str,
    ) -> Result<AdapterInstall> {
        let flags = super::extract_flags(help_out);
        let has = |f: &str| flags.iter().any(|x| x == f);
        Ok(AdapterInstall {
            agent_type: AgentType::Kimi,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            exact_resume: has("session"),
            // No per-invocation hook mechanism on 0.27.0 -> degraded.
            hook_status: HookStatus::Degraded,
            approval_model: AgentType::Kimi.approval_model(),
            default_transport: AgentType::Kimi.default_transport(),
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
            AgentType::Kimi,
            ctx.preset.permission_mode,
            install,
        )?);
        Ok(LaunchPlan {
            argv,
            env: vec![],
            assigned_agent_session_id: None,
            // PTY 捕获到 `session_<uuid>` 后可升级为 exact（见 extract_session_id）。
            resume_precision: if install.exact_resume {
                ResumePrecision::Latest
            } else {
                ResumePrecision::Unavailable
            },
            hook_status: install.hook_status,
            transport: ctx.transport,
            helper_files: vec![],
            notices: vec![
                LaunchNotice::new(
                    "kimi_hook_unavailable",
                    "Kimi 无 Session 级 Hook 注入机制（仅全局 ~/.kimi-code/config.toml，不做修改）；单轮完成使用官方 wire 事件，批准请求降级为 PTY 启发式",
                ),
            ],
        })
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        let install = &ctx.install;
        let mut argv = vec![install.executable_path.clone()];
        let mut notices = Vec::new();
        let resume_precision = match &ctx.agent_session_id {
            Some(id) => {
                if !install.exact_resume {
                    return Err(CoreError::Blocked(
                        "this version of kimi has no --session flag and cannot resume a Session exactly".into(),
                    ));
                }
                argv.push("--session".into());
                argv.push(id.clone());
                ResumePrecision::Exact
            }
            None => {
                if !super::has_flag(install, "continue") {
                    return Err(CoreError::Blocked(
                        "no native Session ID is available and this version of kimi has no --continue flag".into(),
                    ));
                }
                argv.push("--continue".into());
                notices.push(LaunchNotice::new(
                    "resume_latest_only",
                    "无原生 Session ID，仅支持恢复最近的 Session",
                ));
                ResumePrecision::Latest
            }
        };
        argv.extend(ctx.preset.args.clone());
        argv.extend(super::permission_argv(
            AgentType::Kimi,
            ctx.permission_mode,
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
            notices,
        })
    }

    fn extract_session_id(&self, stripped_text_tail: &str) -> Option<String> {
        static SESSION_ID_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        // Prompt mode prints `To resume this session: ...`; the interactive
        // TUI renders `Session: session_<uuid>` in its startup header.
        let re = SESSION_ID_RE.get_or_init(|| {
            regex::Regex::new(
                r"(?m)(?:To resume this session:\s*kimi\s+(?:-\w+\s+)*|Session:\s*)(session_[0-9a-fA-F-]{36})",
            )
            .expect("Kimi Session ID regex is a valid constant")
        });
        re.captures_iter(stripped_text_tail)
            .last()
            .map(|captures| captures[1].to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::test_fixtures as fx;

    fn real_install() -> AdapterInstall {
        KimiAdapter
            .parse_capabilities(
                Path::new("/Users/w/.kimi-code/bin/kimi"),
                &fx::read_fixture("kimi-version.txt"),
                &fx::read_fixture("kimi-help.txt"),
            )
            .unwrap()
    }

    #[test]
    fn parse_real_fixtures() {
        let i = real_install();
        assert_eq!(i.version_text, "0.27.0");
        for f in ["session", "continue", "yolo", "auto", "plan", "model"] {
            assert!(i.flags.iter().any(|x| x == f), "missing flag {f}");
        }
        assert!(i.exact_resume);
        // 无会话级 hook 机制 -> 降级
        assert_eq!(i.hook_status, HookStatus::Degraded);
    }

    #[test]
    fn parse_unknown_future_version_degrades() {
        let help = fx::read_fixture("kimi-help.txt").replace("--session", "--sess");
        let i = KimiAdapter
            .parse_capabilities(Path::new("/x/kimi"), "9.9.9", &help)
            .unwrap();
        assert!(!i.exact_resume);
    }

    #[test]
    fn extract_session_id_from_real_output() {
        let out = fx::read_fixture("kimi-print-ok.txt");
        let id = KimiAdapter.extract_session_id(&out);
        assert_eq!(
            id.as_deref(),
            Some("session_950d1775-f55d-48ba-9921-ffcbe1bdaecf")
        );
        assert_eq!(KimiAdapter.extract_session_id("random text"), None);
    }

    #[test]
    fn extract_session_id_from_interactive_tui_header() {
        let out = "Directory: /tmp/work\r\nSession:   session_b7034202-9ba5-405c-8cca-e9788753dade\r\nModel: K3";
        assert_eq!(
            KimiAdapter.extract_session_id(out).as_deref(),
            Some("session_b7034202-9ba5-405c-8cca-e9788753dade")
        );
    }

    #[test]
    fn build_launch_plain_argv_with_notes() {
        let mut ctx = fx::launch_ctx(AgentType::Kimi, &["auto"], PermissionMode::Auto);
        ctx.install.hook_status = HookStatus::Degraded; // 与真实探测结果一致
        let plan = KimiAdapter.build_launch(&ctx).unwrap();
        assert_eq!(plan.argv[1..], ["--auto"]);
        assert_eq!(plan.hook_status, HookStatus::Degraded);
        assert!(plan
            .notices
            .iter()
            .any(|notice| notice.legacy_message.contains("config.toml")));
    }

    #[test]
    fn build_resume_exact_latest_blocked() {
        let ctx = fx::resume_ctx(
            AgentType::Kimi,
            &["session", "continue"],
            Some("session_abc"),
        );
        let plan = KimiAdapter.build_resume(&ctx).unwrap();
        assert_eq!(plan.resume_precision, ResumePrecision::Exact);
        assert_eq!(plan.argv[1..], ["--session", "session_abc"]);

        let ctx = fx::resume_ctx(AgentType::Kimi, &["session", "continue"], None);
        let plan = KimiAdapter.build_resume(&ctx).unwrap();
        assert_eq!(plan.resume_precision, ResumePrecision::Latest);
        assert_eq!(plan.argv[1..], ["--continue"]);
        assert!(plan
            .notices
            .iter()
            .any(|notice| notice.code == "resume_latest_only"));

        // blocked: 有 id 但 install 声明无 exact resume
        let mut ctx = fx::resume_ctx(AgentType::Kimi, &["continue"], Some("session_abc"));
        ctx.install.exact_resume = false;
        assert!(matches!(
            KimiAdapter.build_resume(&ctx),
            Err(crate::error::CoreError::Blocked(_))
        ));
    }
}
