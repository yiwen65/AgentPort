//! Pi identities share native transcript observation, not configuration roots.
//! Only verified Omp approval events add a session-scoped extension observer.
use super::{EventCoverage, EventSource, IntegrationPlan, ManagedAsset};
use crate::models::{AdapterInstall, AgentType};

pub(super) fn plan(install: &AdapterInstall) -> Option<IntegrationPlan> {
    if !matches!(
        install.agent_type,
        AgentType::Pi | AgentType::Omp | AgentType::EasyPi
    ) {
        return None;
    }
    let mut plan = IntegrationPlan {
        strategy: "native_session".into(),
        events: EventCoverage {
            completed: if install.flags.iter().any(|flag| flag == "session-dir") {
                EventSource::Native
            } else {
                EventSource::Heuristic
            },
            needs_input: EventSource::Heuristic,
            failed: EventSource::Process,
        },
        detail: "Managed native transcript completion; waiting for answers is heuristic. Failure coverage is process exit only, not recoverable tool/model errors. Existing plugins, permissions and global settings are preserved.".into(),
        assets: vec![],
        launch_args: vec![],
        launch_env: vec![],
        global_assets: vec![],
        json_registrations: vec![],
        required_commands: vec![],
    };
    if install.agent_type == AgentType::Omp {
        if verified_omp_approval_api(install) {
            plan.strategy = "native_session_and_omp_approval_extension".into();
            plan.events.needs_input = EventSource::Hook;
            plan.assets.push(ManagedAsset {
                name: "omp-approval.ts".into(),
                content: include_str!("pi_assets/omp-approval.ts").into(),
            });
            plan.assets.push(ManagedAsset {
                name: "managed-context.cjs".into(),
                content: include_str!("cli_assets/managed-context.cjs").into(),
            });
            plan.launch_env.push((
                "AGENTPORT_NOTIFICATION_CONTEXT_READER".into(),
                "{{asset_dir}}/managed-context.cjs".into(),
            ));
            plan.launch_args = vec!["--extension".into(), "{{asset_dir}}/omp-approval.ts".into()];
            // /bin/sh is verified by the installer for every provider.
            plan.detail = "Managed native transcript completion and verified Oh My Pi tool approval observer. Custom extension questions remain heuristic; failures cover process exit only. Explicit extension loading preserves existing plugins and permission policy; no global configuration changes.".into();
        } else {
            plan.detail.push_str(" Oh My Pi approval extension requires probed --extension and verified omp/18.0.11 API; unknown versions retain partial native coverage.");
        }
    }
    if plan.events.completed == EventSource::Heuristic {
        plan.detail.push_str(" Probed CLI lacks --session-dir; managed native transcript observation is unavailable.");
    }
    Some(plan)
}

fn verified_omp_approval_api(install: &AdapterInstall) -> bool {
    // Loading syntax alone cannot prove an event exists. Keep an explicit source-
    // verified version allowlist rather than silently claiming future APIs work.
    install.flags.iter().any(|flag| flag == "extension")
        && install.version_text.split_whitespace().next() == Some("omp/18.0.11")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AgentTransport, ApprovalModel, HookStatus};

    fn install(agent: AgentType) -> AdapterInstall {
        AdapterInstall {
            agent_type: agent,
            executable_path: "/fixture/agent".into(),
            version_text: "omp/18.0.11 darwin-arm64".into(),
            capability_hash: "sha256:fixture".into(),
            exact_resume: true,
            hook_status: HookStatus::Unavailable,
            approval_model: ApprovalModel::NoBuiltinPrompts,
            default_transport: AgentTransport::Pty,
            probed_at: chrono::Utc::now(),
            candidates: vec![],
            flags: vec!["extension".into(), "session-dir".into()],
        }
    }

    #[test]
    fn pi_identities_do_not_mutate_global_configuration_or_duplicate_completion() {
        for agent in [AgentType::Pi, AgentType::Omp, AgentType::EasyPi] {
            let plan = plan(&install(agent)).unwrap();
            assert_eq!(plan.events.completed, EventSource::Native);
            assert_eq!(plan.events.failed, EventSource::Process);
            assert!(plan.global_assets.is_empty());
            assert!(plan.json_registrations.is_empty());
            if agent != AgentType::Omp {
                assert!(plan.launch_env.is_empty());
                assert!(plan.assets.is_empty());
                assert!(plan.launch_args.is_empty());
                assert_eq!(plan.events.needs_input, EventSource::Heuristic);
            }
        }
    }

    #[test]
    fn omp_requires_both_probed_loading_flag_and_verified_api_version() {
        let mut install = install(AgentType::Omp);
        let supported = plan(&install).unwrap();
        assert_eq!(supported.events.needs_input, EventSource::Hook);
        assert_eq!(supported.assets.len(), 2);
        assert_eq!(supported.launch_args[0], "--extension");
        install.version_text = "omp/19.0.0".into();
        assert!(plan(&install).unwrap().assets.is_empty());
        install.version_text = "omp/18.0.11".into();
        install.flags.clear();
        assert!(plan(&install).unwrap().assets.is_empty());
    }
}
