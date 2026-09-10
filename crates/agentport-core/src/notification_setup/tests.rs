use super::*;
use crate::models::{AgentTransport, ApprovalModel, HookStatus};
fn temporary() -> tempfile::TempDir {
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}
fn fixture() -> AdapterInstall {
    AdapterInstall {
        agent_type: AgentType::Pi,
        executable_path: "/fixture/pi".into(),
        version_text: "fixture".into(),
        capability_hash: "fixture".into(),
        exact_resume: true,
        hook_status: HookStatus::Unavailable,
        approval_model: ApprovalModel::NoBuiltinPrompts,
        default_transport: AgentTransport::Pty,
        probed_at: Utc::now(),
        candidates: vec![],
        flags: vec![],
    }
}
fn plan() -> IntegrationPlan {
    IntegrationPlan {
        strategy: "fixture".into(),
        events: EventCoverage {
            completed: EventSource::Native,
            needs_input: EventSource::Heuristic,
            failed: EventSource::Process,
        },
        detail: "fixture".into(),
        assets: vec![],
        launch_args: vec![],
        launch_env: vec![],
        global_assets: vec![GlobalAsset {
            relative_path: ".fixture/plugins/agentport.js".into(),
            content: "managed".into(),
        }],
        json_registrations: vec![JsonRegistration {
            relative_path: ".fixture/settings.json".into(),
            pointer: "/hooks/Stop".into(),
            entries: vec![serde_json::json!({"command":"managed"})],
        }],
        required_commands: vec![],
    }
}
#[test]
fn isolated_install_repeat_rollback_preserves_exact_existing_bytes() {
    let tmp = temporary();
    let home = tmp.path().join("home");
    let paths = AppPaths::new(tmp.path().join("data"));
    fs::create_dir_all(home.join(".fixture")).unwrap();
    let config = home.join(".fixture/settings.json");
    let original = b"{\n  \"custom\": true, \"hooks\": {\"Stop\": [{\"command\":\"user\"}]}\n}\n";
    fs::write(&config, original).unwrap();
    let install = fixture();
    let status = install_plan(&paths, &install, Some(&home), plan()).unwrap();
    assert_eq!(status.state, SetupState::Degraded);
    let once = fs::read(&config).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&once).unwrap();
    assert_eq!(value["hooks"]["Stop"].as_array().unwrap().len(), 2);
    assert_eq!(value["custom"], true);
    install_plan(&paths, &install, Some(&home), plan()).unwrap();
    assert_eq!(fs::read(&config).unwrap(), once);
    rollback(&paths, install.agent_type).unwrap();
    assert_eq!(fs::read(&config).unwrap(), original);
    assert!(!home.join(".fixture/plugins/agentport.js").exists());
}
#[test]
fn user_edit_blocks_rollback_before_any_files_are_removed() {
    let tmp = temporary();
    let home = tmp.path().join("home");
    let paths = AppPaths::new(tmp.path().join("data"));
    let install = fixture();
    install_plan(&paths, &install, Some(&home), plan()).unwrap();
    let config = home.join(".fixture/settings.json");
    fs::write(&config, b"user edit").unwrap();
    assert!(rollback(&paths, install.agent_type).is_err());
    assert_eq!(fs::read(&config).unwrap(), b"user edit");
    assert!(home.join(".fixture/plugins/agentport.js").exists());
}
#[test]
fn unsupported_json_or_symlink_never_changes_user_config() {
    let tmp = temporary();
    let home = tmp.path().join("home");
    let paths = AppPaths::new(tmp.path().join("data"));
    fs::create_dir_all(home.join(".fixture")).unwrap();
    let config = home.join(".fixture/settings.json");
    fs::write(&config, b"// jsonc\n{}").unwrap();
    assert!(install_plan(&paths, &fixture(), Some(&home), plan()).is_err());
    assert_eq!(fs::read(&config).unwrap(), b"// jsonc\n{}");
    assert!(!home.join(".fixture/plugins/agentport.js").exists());
    fs::remove_file(&config).unwrap();
    let target = tmp.path().join("target");
    fs::write(&target, b"{}").unwrap();
    std::os::unix::fs::symlink(&target, &config).unwrap();
    assert!(install_plan(&paths, &fixture(), Some(&home), plan()).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"{}");
}
#[test]
fn missing_runtime_and_existing_unowned_plugin_are_rejected() {
    let tmp = temporary();
    let home = tmp.path().join("home");
    let paths = AppPaths::new(tmp.path().join("data"));
    let mut p = plan();
    p.required_commands
        .push("agentport_nonexistent_runtime_fixture".into());
    assert!(install_plan(&paths, &fixture(), Some(&home), p).is_err());
    fs::create_dir_all(home.join(".fixture/plugins")).unwrap();
    let plugin = home.join(".fixture/plugins/agentport.js");
    fs::write(&plugin, b"existing").unwrap();
    assert!(install_plan(&paths, &fixture(), Some(&home), plan()).is_err());
    assert_eq!(fs::read(&plugin).unwrap(), b"existing");
}
#[test]
fn relay_requires_identity_and_never_copies_stdin() {
    let tmp = temporary();
    let relay = tmp.path().join("relay.sh");
    fs::write(&relay, RELAY).unwrap();
    let events = tmp.path().join("events");
    fs::write(&events, b"").unwrap();
    let run = |ids: bool, kind: &str| {
        let mut c = std::process::Command::new("/bin/sh");
        c.arg(&relay)
            .arg(kind)
            .env_clear()
            .env("HOME", tmp.path())
            .env("AGENTPORT_HOOK_EVENTS_FILE", &events);
        if ids {
            c.env("AGENTPORT_SESSION_ID", "ses_1")
                .env("AGENTPORT_RUN_ID", "run_1")
                .env("AGENTPORT_NOTIFICATION_TOKEN", "token_1");
        }
        assert!(c.status().unwrap().success());
    };
    run(false, "completed");
    assert!(fs::read(&events).unwrap().is_empty());
    for kind in ["completed", "needs_input", "failed"] {
        run(true, kind);
    }
    let data = fs::read_to_string(&events).unwrap();
    let rows: Vec<serde_json::Value> = data
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(rows.len(), 3);
    for row in rows {
        assert_eq!(row.as_object().unwrap().len(), 5);
        assert_eq!(row["sessionId"], "ses_1");
    }
}

#[test]
fn same_config_multiple_arrays_merge_without_losing_prior_registration() {
    let tmp = temporary();
    let home = tmp.path().join("home");
    let paths = AppPaths::new(tmp.path().join("data"));
    let mut p = plan();
    p.json_registrations.push(JsonRegistration {
        relative_path: ".fixture/settings.json".into(),
        pointer: "/hooks/Wait".into(),
        entries: vec![serde_json::json!({"command":"wait"})],
    });
    install_plan(&paths, &fixture(), Some(&home), p).unwrap();
    let v: serde_json::Value =
        serde_json::from_slice(&fs::read(home.join(".fixture/settings.json")).unwrap()).unwrap();
    assert_eq!(v["hooks"]["Stop"][0]["command"], "managed");
    assert_eq!(v["hooks"]["Wait"][0]["command"], "wait");
}
#[test]
fn rollback_recovers_interrupted_install_and_refuses_lock_contention() {
    let tmp = temporary();
    let paths = AppPaths::new(tmp.path().join("data"));
    let home = tmp.path().join("home");
    let install = fixture();
    install_plan(&paths, &install, Some(&home), plan()).unwrap();
    let dir = base(&paths, install.agent_type);
    fs::rename(dir.join("manifest.json"), dir.join("pending.json")).unwrap();
    assert!(install_plan(&paths, &install, Some(&home), plan()).is_err());
    {
        let _guard = lock(&dir).unwrap();
        assert!(rollback(&paths, install.agent_type).is_err());
    }
    rollback(&paths, install.agent_type).unwrap();
    assert!(!home.join(".fixture/settings.json").exists());
    assert!(!dir.join("pending.json").exists());
}

#[test]
fn changed_provider_assets_never_reuse_cached_readiness() {
    let tmp = temporary();
    let home = tmp.path().join("home");
    let paths = AppPaths::new(tmp.path().join("data"));
    let mut install = fixture();
    install_plan(&paths, &install, Some(&home), plan()).unwrap();
    let plugin = home.join(".fixture/plugins/agentport.js");
    let original = fs::read(&plugin).unwrap();
    let mut changed = plan();
    changed.global_assets[0].content = "updated observer".into();
    let error = install_plan(&paths, &install, Some(&home), changed).unwrap_err();
    assert!(error.to_string().contains("Roll back"));
    assert_eq!(fs::read(&plugin).unwrap(), original);
    install.capability_hash = "different version".into();
    assert!(install_plan(&paths, &install, Some(&home), plan()).is_err());
    assert_eq!(fs::read(&plugin).unwrap(), original);
    rollback(&paths, install.agent_type).unwrap();
    install_plan(&paths, &install, Some(&home), plan()).unwrap();
}

#[test]
fn legacy_manifest_requires_reprobe_after_safe_rollback() {
    let tmp = temporary();
    let home = tmp.path().join("home");
    let paths = AppPaths::new(tmp.path().join("data"));
    let install = fixture();
    install_plan(&paths, &install, Some(&home), plan()).unwrap();
    let file = base(&paths, install.agent_type).join("manifest.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    value.as_object_mut().unwrap().remove("source_hash");
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    assert!(install_plan(&paths, &install, Some(&home), plan()).is_err());
    rollback(&paths, install.agent_type).unwrap();
    assert!(!home.join(".fixture/plugins/agentport.js").exists());
}

#[test]
fn actual_provider_installations_preserve_user_files_and_resolve_assets() {
    for agent in [
        AgentType::Omp,
        AgentType::Gemini,
        AgentType::CursorAgent,
        AgentType::GrokBuild,
    ] {
        let tmp = temporary();
        let home = tmp.path().join("home");
        let paths = AppPaths::new(tmp.path().join("data"));
        let mut install = fixture();
        install.agent_type = agent;
        install.version_text = "omp/18.0.11 darwin-arm64".into();
        install.flags = vec!["extension".into(), "session-dir".into()];
        let original = b"{\n  \"userSetting\": true\n}\n";
        let config = match agent {
            AgentType::Gemini => Some(home.join(".gemini/settings.json")),
            AgentType::CursorAgent => Some(home.join(".cursor/hooks.json")),
            _ => None,
        };
        if let Some(config) = &config {
            fs::create_dir_all(config.parent().unwrap()).unwrap();
            fs::write(config, original).unwrap();
        }
        let status = setup_inner(&paths, &install, Some(&home)).unwrap();
        assert_eq!(status.state, SetupState::Degraded, "{agent:?}");
        let manifest = load(&base(&paths, agent)).unwrap().unwrap();
        assert!(!manifest.source_hash.is_empty());
        assert!(manifest
            .plan
            .launch_args
            .iter()
            .all(|arg| !arg.contains("{{asset_dir}}")));
        assert!(manifest
            .plan
            .launch_env
            .iter()
            .all(|(_, value)| !value.contains("{{asset_dir}}")));
        if agent == AgentType::Omp {
            assert!(base(&paths, agent).join("assets/omp-approval.ts").is_file());
        }
        if agent == AgentType::GrokBuild {
            assert!(home
                .join(".grok/hooks/agentport-notifications.json")
                .is_file());
        }
        if let Some(config) = &config {
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(config).unwrap()).unwrap();
            assert_eq!(value["userSetting"], true);
        }
        setup_inner(&paths, &install, Some(&home)).unwrap();
        rollback(&paths, agent).unwrap();
        if let Some(config) = &config {
            assert_eq!(fs::read(config).unwrap(), original);
        }
    }
}

#[test]
fn gemini_disabled_observer_or_hooks_never_changes_config() {
    let mut install = fixture();
    install.agent_type = AgentType::Gemini;
    let provider = providers_cli::plan(&install).unwrap();
    let command = provider.json_registrations[0].entries[0]["hooks"][0]["command"]
        .as_str()
        .unwrap();
    for gate in [
        serde_json::json!({"enabled":false}),
        serde_json::json!({"disabled":["agentport-notifications"]}),
        serde_json::json!({"disabled":[command]}),
    ] {
        let tmp = temporary();
        let home = tmp.path().join("home");
        let paths = AppPaths::new(tmp.path().join("data"));
        let config = home.join(".gemini/settings.json");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        let original =
            serde_json::to_vec_pretty(&serde_json::json!({"hooksConfig":gate,"userSetting":17}))
                .unwrap();
        fs::write(&config, &original).unwrap();
        let error = setup_inner(&paths, &install, Some(&home)).unwrap_err();
        assert!(error.to_string().contains("disabled by user settings"));
        assert_eq!(fs::read(&config).unwrap(), original);
        assert!(!base(&paths, AgentType::Gemini)
            .join("assets/relay.sh")
            .exists());
    }
}
