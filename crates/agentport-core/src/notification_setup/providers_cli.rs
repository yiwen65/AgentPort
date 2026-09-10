//! Evidence-backed notification observers for the eleven non-Pi agents.
//! Native configuration is never replaced; see docs/notification-cli-evidence.md.
use super::{
    EventCoverage, EventSource, GlobalAsset, IntegrationPlan, JsonRegistration, ManagedAsset,
};
use crate::models::{AdapterInstall, AgentType, HookStatus};
use serde_json::json;

fn coverage(
    completed: EventSource,
    needs_input: EventSource,
    failed: EventSource,
) -> EventCoverage {
    EventCoverage {
        completed,
        needs_input,
        failed,
    }
}

fn base(strategy: &str, events: EventCoverage, detail: &str) -> IntegrationPlan {
    IntegrationPlan {
        strategy: strategy.into(),
        events,
        detail: detail.into(),
        assets: vec![],
        launch_args: vec![],
        launch_env: vec![],
        global_assets: vec![],
        json_registrations: vec![],
        required_commands: vec![],
    }
}

fn context_reader(plan: &mut IntegrationPlan) {
    plan.assets.push(ManagedAsset {
        name: "managed-context.cjs".into(),
        content: include_str!("cli_assets/managed-context.cjs").into(),
    });
    plan.launch_env.push((
        "AGENTPORT_NOTIFICATION_CONTEXT_READER".into(),
        "{{asset_dir}}/managed-context.cjs".into(),
    ));
}

fn global_plugin(plan: &mut IntegrationPlan, agent: AgentType, path: &str, content: &str) {
    context_reader(plan);
    plan.global_assets.push(GlobalAsset {
        relative_path: path.into(),
        content: content.into(),
    });
    plan.launch_env
        .push(("AGENTPORT_NOTIFICATION_AGENT".into(), agent.as_str().into()));
}

fn json_hook(plan: &mut IntegrationPlan, agent: AgentType) -> String {
    context_reader(plan);
    plan.required_commands.push("node".into());
    plan.assets.push(ManagedAsset {
        name: "json-hook.cjs".into(),
        content: include_str!("cli_assets/json-hook.cjs").into(),
    });
    plan.launch_env.extend([
        ("AGENTPORT_NOTIFICATION_AGENT".into(), agent.as_str().into()),
        (
            "AGENTPORT_NOTIFICATION_JSON_HOOK".into(),
            "{{asset_dir}}/json-hook.cjs".into(),
        ),
    ]);
    // Grok expands $VARS at configuration load time, before sh -c. Keep paths
    // entirely out of shell syntax: read them from the Node environment instead.
    // The native runtime can therefore neither freeze nor reparse path contents.
    format!("command -v node >/dev/null 2>&1 && node -e 'if(process.env.AGENTPORT_NOTIFICATION_AGENT===\"{agent}\" && process.env.AGENTPORT_NOTIFICATION_JSON_HOOK){{process.argv[2]=\"{agent}\";require(process.env.AGENTPORT_NOTIFICATION_JSON_HOOK)}}' || true", agent = agent.as_str())
}

pub(super) fn plan(install: &AdapterInstall) -> Option<IntegrationPlan> {
    use AgentType::*;
    use EventSource::*;
    let agent = install.agent_type;
    let supported = install.hook_status == HookStatus::Supported;
    Some(match agent {
        Claude => base("existing-session-settings", coverage(if supported { Hook } else { Heuristic }, if supported { Hook } else { Heuristic }, Process),
            "Preserves the existing per-invocation --settings hook integration; no duplicate global hooks. Model failure without process exit remains unverified."),
        Codex => base("existing-session-notify", coverage(if supported { Hook } else { Heuristic }, if supported { Hook } else { Heuristic }, Process),
            "Preserves the capability-gated per-invocation notify/filter integration and hook trust. No global TOML changes; model errors without process exit remain unverified."),
        Qoder => base("existing-session-settings", coverage(if supported { Hook } else { Heuristic }, Heuristic, Process),
            "Preserves existing per-invocation settings hooks. PreToolUse is not an approval event; reliable waiting and model-failure hooks are not verified."),
        Kimi => base("existing-native-wire", coverage(Native, Heuristic, Process),
            "Preserves the managed native wire JSONL TurnEnd watcher; waiting remains PTY heuristic. No duplicate global hooks. Failure coverage is process termination only, not every model error."),
        Opencode => {
            let mut p = base("global-native-plugin", coverage(Heuristic, Hook, Hook),
                "Self-contained OpenCode plugin uses permission.asked and session.error, excludes child sessions and abort errors. session.idle also follows cancellation/error, so successful completion remains heuristic. Requires current native plugin/session SDK APIs; no Bun/npm installation.");
            global_plugin(&mut p, agent, ".config/opencode/plugins/agentport-notifications.js", include_str!("cli_assets/opencode-notifications.js"));
            p
        }
        Amp => {
            let mut p = base("global-native-plugin", coverage(Hook, Heuristic, Hook),
                "Native Amp plugin observes agent.end done/error (ignores cancelled), correlates message IDs and excludes child threads. Observes actual awaiting-approval when the thread-state API exists; arbitrary plugin questions have no verified universal event, so waiting remains partial/heuristic. Requires current Bun-hosted plugin API; no npm dependencies.");
            global_plugin(&mut p, agent, ".config/amp/plugins/agentport-notifications.js", include_str!("cli_assets/amp-notifications.js"));
            p
        }
        Cline => {
            let mut p = base("global-native-plugin", coverage(Hook, Heuristic, Hook),
                "Native Cline single-file plugin checks afterRun result.status completed/failed and excludes child snapshots; aborted is ignored. Approval/user-question observation is unverified. Requires the current CLI AgentPlugin auto-discovery/runtime snapshot API; no SDK/npm installation.");
            global_plugin(&mut p, agent, ".cline/plugins/agentport-notifications.js", include_str!("cli_assets/cline-notifications.js"));
            p
        }
        Gemini => {
            let mut p = base("merged-notification-hook-private-context", coverage(Heuristic, Hook, Process),
                "Adds only Notification/ToolPermission to strict-JSON settings. Gemini strips TOKEN environment variables; the observer instead validates a same-user mode-0600 per-launch context file, without changing native redaction or writing secrets globally. Requires Node and current hooks support. AfterAgent is a blocking gate; completion remains heuristic, failure process-only. Native disabled hooks remain disabled.");
            let command = json_hook(&mut p, agent);
            p.json_registrations.push(JsonRegistration {
                relative_path: ".gemini/settings.json".into(), pointer: "/hooks/Notification".into(),
                entries: vec![json!({"matcher":"ToolPermission","hooks":[{"name":"agentport-notifications","type":"command","command":command,"timeout":3000}]})],
            });
            p
        }
        CursorAgent => {
            let mut p = base("merged-stop-hook", coverage(Hook, Heuristic, Hook),
                "Adds a strict-JSON stop observer; status completed/error is mapped and aborted ignored. No verified passive waiting-for-approval event. Requires current Cursor CLI hooks support and Node on PATH; preserves all hook and permission settings.");
            let command = json_hook(&mut p, agent);
            p.json_registrations.push(JsonRegistration {
                relative_path: ".cursor/hooks.json".into(), pointer: "/hooks/stop".into(),
                entries: vec![json!({"command":command})],
            });
            p
        }
        GrokBuild => {
            let mut p = base("standalone-native-hooks", coverage(Heuristic, Hook, Hook),
                "Standalone Grok hooks observe actual permission_prompt and main-agent StopFailure, ignoring child events and reports whose native prompt ID is not the latest submitted turn. Requires Node on PATH and the current Grok hook schema. Stop is a blocking gate, idle_prompt also follows abort/error, and task_complete describes background tasks: none is mislabeled successful turn completion.");
            let command = json_hook(&mut p, agent);
            p.global_assets.push(GlobalAsset {
                relative_path: ".grok/hooks/agentport-notifications.json".into(),
                content: json!({"hooks":{
                    "UserPromptSubmit":[{"hooks":[{"type":"command","command":command,"timeout":3}]}],
                    "Notification":[{"matcher":"^permission_prompt$","hooks":[{"type":"command","command":command,"timeout":3}]}],
                    "StopFailure":[{"hooks":[{"type":"command","command":command,"timeout":3}]}]
                }}).to_string(),
            });
            p
        }
        KiroCli => base("documented-hook-degradation", coverage(Heuristic, Heuristic, Process),
            "No hook installed: current Kiro CLI 3 migration reference says Stop is session-end/nonblocking, while shared hook-types reference says turn-end/blocking. Waiting/error events are not documented. CLI 2 embeds hooks in selected agent configuration; AgentPort does not replace the user's agent or guess a versioned schema."),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::*;

    fn install(agent_type: AgentType) -> AdapterInstall {
        AdapterInstall {
            agent_type,
            executable_path: "/tmp/reference-cli".into(),
            version_text: "reference".into(),
            capability_hash: "fixture".into(),
            exact_resume: false,
            hook_status: HookStatus::Degraded,
            approval_model: agent_type.approval_model(),
            default_transport: agent_type.default_transport(),
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags: vec![],
        }
    }

    #[test]
    fn covers_eleven_without_duplicate_legacy_installations() {
        for agent in [
            AgentType::Claude,
            AgentType::Codex,
            AgentType::Qoder,
            AgentType::Kimi,
            AgentType::Opencode,
            AgentType::Amp,
            AgentType::Gemini,
            AgentType::Cline,
            AgentType::KiroCli,
            AgentType::CursorAgent,
            AgentType::GrokBuild,
        ] {
            let p = plan(&install(agent)).unwrap();
            assert!(
                p.launch_args.is_empty(),
                "must not change native agent or permissions"
            );
            if matches!(
                agent,
                AgentType::Claude
                    | AgentType::Codex
                    | AgentType::Qoder
                    | AgentType::Kimi
                    | AgentType::KiroCli
            ) {
                assert!(p.global_assets.is_empty() && p.json_registrations.is_empty());
            }
        }
        assert!(plan(&install(AgentType::Pi)).is_none());
        assert!(plan(&install(AgentType::Shell)).is_none());
    }

    #[test]
    fn registrations_do_not_confuse_tool_execution_with_approval() {
        for agent in [AgentType::GrokBuild, AgentType::CursorAgent] {
            let p = plan(&install(agent)).unwrap();
            for registration in &p.json_registrations {
                assert!(!registration.pointer.contains("BeforeTool"));
                assert!(!registration.pointer.contains("PreTool"));
            }
            for asset in &p.global_assets {
                let value: serde_json::Value = serde_json::from_str(&asset.content).unwrap();
                assert!(value["hooks"].get("Stop").is_none());
                assert!(value["hooks"].get("PreToolUse").is_none());
            }
            assert!(p.launch_env.iter().any(
                |(key, value)| key == "AGENTPORT_NOTIFICATION_AGENT" && value == agent.as_str()
            ));
        }
    }
}
