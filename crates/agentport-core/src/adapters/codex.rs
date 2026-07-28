//! Codex adapter. Verified on this machine against codex-cli 0.144.5 and 0.145.0
//! (fixtures in tests/fixtures/cli/):
//! - `codex resume [SESSION_ID]` : exact resume by UUID (or name).
//! - `codex resume --last`       : latest session for this cwd (precision = latest).
//! - `-c key=value`              : per-invocation config override (confirmed in --help).
//!   Builds exposing `--dangerously-bypass-hook-trust` have Codex's documented
//!   current notification surface. AgentPort configures the external notifier
//!   for every turn and filters it to completion/approval events, scoped to this
//!   invocation; it never changes ~/.codex/config.toml or bypasses hook trust.
//! - Session-id capture: `codex exec --json` emits
//!   `{"type":"thread.started","thread_id":"<uuid>"}` (verified 2026-07-18,
//!   fixture codex-exec-ok.txt). Whether the interactive TUI prints the id is
//!   unverified, so launch precision stays Latest; extract_session_id still
//!   recognizes the thread.started line when it appears (e.g. exec in PTY).
//! - Approval flags on 0.144.5 (verified): `-a, --ask-for-approval
//!   <untrusted|on-request|never>` and `--dangerously-bypass-approvals-and-sandbox`.
//!   `--full-auto` does NOT exist on this version. Only flags proven present in
//!   parsed --help output are ever used.

use super::{AgentAdapter, LaunchContext, LaunchNotice, LaunchPlan, ResumeContext};
use crate::error::{CoreError, Result};
use crate::models::*;
use std::path::Path;

pub struct CodexAdapter;

fn notifier_relay_script() -> String {
    r#"#!/bin/sh
# Codex appends one compact JSON event as the final argument. AgentPort maps
# only the two user-notifiable types and never persists the original payload.
case "$3" in
  *'"type":"agent-turn-complete"'*) event='Stop' ;;
  *'"type":"approval-requested"'*) event='PermissionRequest' ;;
  *) exit 0 ;;
esac
native_id=$(
  printf '%s\n' "$3" |
    sed -n 's/.*"thread-id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
)
if [ "${#native_id}" -eq 36 ] &&
   ! printf '%s' "$native_id" | grep -q '[^0-9a-fA-F-]'; then
  printf '{"event":"%s","agentport_session_id":"%s","data":{"session_id":"%s"}}\n' \
    "$event" "$1" "$native_id" >> "$2"
else
  printf '{"event":"%s","agentport_session_id":"%s"}\n' "$event" "$1" >> "$2"
fi
"#
    .into()
}

fn hook_plan(
    install: &AdapterInstall,
    ctx: &LaunchContext,
    argv: &mut Vec<String>,
    notices: &mut Vec<LaunchNotice>,
) -> (HookStatus, Vec<(String, String)>) {
    if install.hook_status != HookStatus::Supported {
        notices.push(LaunchNotice::new(
            "codex_hook_unverified",
            "该版本未暴露可验证的会话级 Hook 能力，状态降级为 PTY 启发式",
        ));
        return (HookStatus::Degraded, vec![]);
    }

    let relay = format!("{}/codex-notify-relay.sh", ctx.session_dir);
    // JSON string arrays are valid TOML arrays. Passing every override as one
    // argv item avoids shell interpolation and changes only this Codex process.
    let notify_argv = serde_json::to_string(&vec![
        "sh",
        relay.as_str(),
        ctx.session_id.as_str(),
        ctx.hook_events_path.as_str(),
    ])
    .unwrap_or_else(|_| "[]".into());
    argv.extend(["-c".into(), format!("notify={notify_argv}")]);
    argv.extend([
        "-c".into(),
        "tui.notifications=[\"agent-turn-complete\",\"approval-requested\"]".into(),
    ]);
    argv.extend(["-c".into(), "tui.notification_condition=\"always\"".into()]);
    (
        HookStatus::Supported,
        vec![(relay, notifier_relay_script())],
    )
}

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
        let has = |flag: &str| flags.iter().any(|value| value == flag);
        // Exact resume iff the resume subcommand accepts a SESSION_ID argument.
        let exact_resume = help_out.contains("[SESSION_ID]")
            || (help_out.contains("resume") && help_out.contains("SESSION_ID"));
        Ok(AdapterInstall {
            agent_type: AgentType::Codex,
            executable_path: exe.to_string_lossy().into_owned(),
            version_text: super::normalize_version(version_out),
            capability_hash: super::capability::capability_hash(version_out, help_out),
            exact_resume,
            // This flag is an explicit runtime signal that the current Codex
            // generation exposes the documented notification/filter surface.
            hook_status: if has("config") && has("dangerously-bypass-hook-trust") {
                HookStatus::Supported
            } else {
                HookStatus::Degraded
            },
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
        let mut notices = Vec::new();
        let (hook_status, helper_files) = hook_plan(install, ctx, &mut argv, &mut notices);
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
            hook_status,
            transport: ctx.transport,
            helper_files,
            notices: {
                notices.push(LaunchNotice::new(
                    "codex_session_id_unverified",
                    "首轮完成通知前尚无原生 Session ID；收到通知后将升级为精确恢复",
                ));
                notices
            },
        })
    }

    fn build_resume(&self, ctx: &ResumeContext) -> Result<LaunchPlan> {
        let install = &ctx.install;
        let mut argv = vec![install.executable_path.clone()];
        let mut notices = Vec::new();
        let launch_ctx = ctx.to_launch_context();
        let (hook_status, helper_files) = hook_plan(install, &launch_ctx, &mut argv, &mut notices);
        let resume_precision = match &ctx.agent_session_id {
            Some(id) => {
                if !install.exact_resume {
                    return Err(CoreError::Blocked(
                        "this version of codex resume does not accept SESSION_ID and cannot resume exactly".into(),
                    ));
                }
                argv.push("resume".into());
                argv.push(id.clone());
                ResumePrecision::Exact
            }
            None => {
                argv.push("resume".into());
                argv.push("--last".into());
                notices.push(LaunchNotice::new(
                    "resume_latest_only",
                    "无原生 Session ID，仅支持恢复最近的 Session",
                ));
                ResumePrecision::Latest
            }
        };
        argv.extend(ctx.preset.args.clone());
        argv.extend(super::permission_argv(
            AgentType::Codex,
            ctx.permission_mode,
            install,
        )?);
        Ok(LaunchPlan {
            argv,
            env: vec![],
            assigned_agent_session_id: None,
            resume_precision,
            hook_status,
            transport: ctx.transport,
            helper_files,
            notices,
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
        assert_eq!(i.hook_status, HookStatus::Supported);
    }

    #[test]
    fn parse_unknown_future_version_degrades() {
        // 去掉 resume 子命令的 SESSION_ID 参数
        let help = merged_help()
            .replace("[SESSION_ID]", "")
            .replace("SESSION_ID", "SID")
            .replace("--dangerously-bypass-hook-trust", "--hook-trust-unknown");
        let i = CodexAdapter
            .parse_capabilities(Path::new("/x/codex"), "codex-cli 99.0", &help)
            .unwrap();
        assert!(!i.exact_resume);
        assert_eq!(i.hook_status, HookStatus::Degraded);
    }

    #[test]
    fn parse_current_hook_capability_is_supported() {
        let help = format!(
            "{}\n      --dangerously-bypass-hook-trust\n          Run enabled hooks without persisted trust",
            merged_help()
        );
        let i = CodexAdapter
            .parse_capabilities(Path::new("/x/codex"), "codex-cli 0.145.0", &help)
            .unwrap();
        assert_eq!(i.hook_status, HookStatus::Supported);
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
    fn build_launch_injects_always_on_filtered_notifier_when_supported() {
        let mut ctx = fx::launch_ctx(
            AgentType::Codex,
            &["config", "dangerously-bypass-hook-trust"],
            PermissionMode::Native,
        );
        ctx.install.hook_status = HookStatus::Supported;

        let plan = CodexAdapter.build_launch(&ctx).unwrap();

        assert_eq!(plan.hook_status, HookStatus::Supported);
        assert_eq!(plan.helper_files.len(), 1);
        assert_eq!(
            plan.helper_files[0].0,
            "/tmp/work/.agentport/codex-notify-relay.sh"
        );
        assert!(plan.helper_files[0].1.contains("agentport_session_id"));
        assert!(!plan
            .argv
            .iter()
            .any(|arg| arg == "--dangerously-bypass-hook-trust"));
        let configs = plan
            .argv
            .windows(2)
            .filter_map(|pair| (pair[0] == "-c").then_some(pair[1].as_str()))
            .collect::<Vec<_>>();
        assert_eq!(configs.len(), 3);
        assert!(configs.iter().any(|config| config.starts_with("notify=")));
        assert!(configs
            .iter()
            .any(|config| config == &"tui.notification_condition=\"always\""));
        assert!(configs.iter().any(|config| config
            == &"tui.notifications=[\"agent-turn-complete\",\"approval-requested\"]"));
        assert!(configs.iter().all(|config| !config.starts_with("hooks.")));
        assert!(!plan
            .notices
            .iter()
            .any(|notice| notice.code == "codex_hook_unverified"));
    }

    #[cfg(unix)]
    #[test]
    fn notifier_relay_maps_only_supported_codex_event_types() {
        let temp = tempfile::tempdir().unwrap();
        let relay = temp.path().join("relay.sh");
        let events = temp.path().join("events.jsonl");
        std::fs::write(&relay, notifier_relay_script()).unwrap();

        for payload in [
            r#"{"type":"agent-turn-complete","thread-id":"019f779d-efd0-76a2-a39e-eb95459089a0","secret":"discard-me"}"#,
            r#"{"type":"approval-requested","secret":"discard-me"}"#,
            r#"{"type":"unrelated","secret":"discard-me"}"#,
        ] {
            let status = std::process::Command::new("sh")
                .arg(&relay)
                .arg("ses_abc")
                .arg(&events)
                .arg(payload)
                .status()
                .unwrap();
            assert!(status.success());
        }

        let line = std::fs::read_to_string(events).unwrap();
        let events = line
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            events,
            vec![
                serde_json::json!({
                "event": "Stop",
                "agentport_session_id": "ses_abc",
                "data": {
                    "session_id": "019f779d-efd0-76a2-a39e-eb95459089a0"
                }
                }),
                serde_json::json!({
                    "event": "PermissionRequest",
                    "agentport_session_id": "ses_abc"
                }),
            ]
        );
        assert!(!line.contains("discard-me"));
    }

    #[test]
    fn build_resume_exact_latest() {
        let mut ctx = fx::resume_ctx(AgentType::Codex, &[], Some("uuid-9"));
        ctx.install.hook_status = HookStatus::Supported;
        let plan = CodexAdapter.build_resume(&ctx).unwrap();
        assert_eq!(plan.resume_precision, ResumePrecision::Exact);
        let resume_index = plan.argv.iter().position(|arg| arg == "resume").unwrap();
        assert_eq!(&plan.argv[resume_index..], ["resume", "uuid-9"]);
        assert!(!plan
            .argv
            .iter()
            .any(|arg| arg == "--dangerously-bypass-hook-trust"));
        assert!(plan
            .argv
            .iter()
            .any(|arg| arg == "tui.notification_condition=\"always\""));
        assert_eq!(plan.helper_files.len(), 1);

        let mut ctx = fx::resume_ctx(AgentType::Codex, &[], None);
        ctx.install.hook_status = HookStatus::Supported;
        let plan = CodexAdapter.build_resume(&ctx).unwrap();
        assert_eq!(plan.resume_precision, ResumePrecision::Latest);
        let resume_index = plan.argv.iter().position(|arg| arg == "resume").unwrap();
        assert_eq!(&plan.argv[resume_index..], ["resume", "--last"]);
        assert_eq!(plan.helper_files.len(), 1);
        assert!(plan
            .notices
            .iter()
            .any(|notice| notice.code == "resume_latest_only"));
    }
}
