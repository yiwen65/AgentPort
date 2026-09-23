//! Env-gated E2E against a REAL Linux controlled end (the Docker fixture from
//! docs/tasks/2026-09-23-desktop-multi-device-switching-task.md T-012):
//! real OpenSSH, real Linux agentport-remote-bridge/host, real relay server +
//! connector. No fixtures are stubbed except the keychain (MemoryCredentialStore).
//!
//!   AGENTPORT_E2E=1 \
//!   AGENTPORT_E2E_SSH=127.0.0.1:52222:ap:ap-e2e-pass \
//!   AGENTPORT_E2E_INVITATION='<invitation-json>' (relay test only) \
//!   cargo test -p agentport e2e_linux -- --ignored --nocapture

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as SyncMutex};
    use std::time::{Duration, Instant};

    use agentport_core::paths::AppPaths;
    use base64::Engine as _;
    use serde_json::{json, Value};

    use crate::remote::credentials::MemoryCredentialStore;
    use crate::remote::manager::RemoteConnectionManager;
    use crate::remote::pairing;
    use crate::remote::registry::{DeviceAddSshDraft, DeviceRegistry, DeviceSshAuthDraft};
    use crate::remote::RemoteEventMsg;
    use zeroize::Zeroizing;

    fn enabled() -> bool {
        std::env::var("AGENTPORT_E2E").ok().as_deref() == Some("1")
    }

    struct Fixture {
        _dir: Option<tempfile::TempDir>,
        manager: Arc<RemoteConnectionManager>,
        registry: Arc<DeviceRegistry>,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::TempDir::new().expect("tempdir");
        let root = dir.path().join("data-root");
        fixture_at(root, Some(dir))
    }

    /// Same stack rooted at a CALLER-CHOSEN data dir (GUI seeding): the debug
    /// GUI launched with AGENTPORT_DATA_DIR=<root> then sees exactly the
    /// devices/identity this fixture persists.
    fn fixture_at(root: std::path::PathBuf, dir: Option<tempfile::TempDir>) -> Fixture {
        let paths = AppPaths::new(root.clone());
        let manager = Arc::new(RemoteConnectionManager::new(&paths).expect("manager"));
        let credentials = Arc::new(MemoryCredentialStore::default());
        let registry = DeviceRegistry::open(root.join("devices").join("devices.json"), credentials)
            .expect("registry");
        manager.set_resolver(registry.clone());
        Fixture {
            _dir: dir,
            manager,
            registry,
        }
    }

    fn ssh_target() -> (String, u16, String, Zeroizing<String>) {
        // host:port:user:password
        let raw = std::env::var("AGENTPORT_E2E_SSH").expect("AGENTPORT_E2E_SSH");
        let parts: Vec<&str> = raw.splitn(4, ':').collect();
        assert_eq!(parts.len(), 4, "AGENTPORT_E2E_SSH must be host:port:user:pass");
        (
            parts[0].to_string(),
            parts[1].parse().expect("port"),
            parts[2].to_string(),
            Zeroizing::new(parts[3].to_string()),
        )
    }

    fn collect_output(events: &Arc<SyncMutex<Vec<RemoteEventMsg>>>) -> Vec<u8> {
        let mut bytes = Vec::new();
        for event in events.lock().unwrap().iter() {
            if event.event_type != "output" {
                continue;
            }
            if let Some(data) = event.payload.get("data").and_then(Value::as_str) {
                if let Ok(chunk) = base64::engine::general_purpose::STANDARD.decode(data) {
                    bytes.extend_from_slice(&chunk);
                }
            }
        }
        bytes
    }

    /// SSH 全链路：probe/TOFU → connect/hello → project.add → session.create(shell)
    /// → attach 事件流 → input 回显标记 → git read+write → 断开重连后会话仍在。
    #[test]
    #[ignore = "requires the Linux container fixture (AGENTPORT_E2E=1)"]
    fn ssh_full_stack_against_linux_container() {
        if !enabled() {
            return;
        }
        let (host, port, username, password) = ssh_target();
        let fx = fixture();

        // 1. device_add_ssh：真 probe（TOFU + hello），持久化注册表 + 内存凭据。
        let profile = fx
            .registry
            .add_ssh_device(
                fx.manager.ssh_prober().as_ref(),
                DeviceAddSshDraft {
                    name: Some("e2e-linux".to_string()),
                    hostname: host,
                    port,
                    username,
                    auth: DeviceSshAuthDraft::Password { password },
                },
            )
            .expect("device_add_ssh must probe+persist");
        assert!(profile.id.starts_with("dev_"));
        assert!(fx.registry.get(&profile.id).is_some());

        // 2. connect + hello 协商。
        let hello = fx.manager.connect(&profile.id).expect("remote_connect");
        println!("hello: {hello:?}");
        assert!(!hello.device_name.is_empty());

        // 3. 订阅设备事件流（attach 前，保证不丢 replay）。
        let events: Arc<SyncMutex<Vec<RemoteEventMsg>>> = Arc::new(SyncMutex::new(Vec::new()));
        let sink = events.clone();
        fx.manager
            .subscribe(
                &profile.id,
                Arc::new(move |msg: &RemoteEventMsg| {
                    sink.lock().unwrap().push(msg.clone());
                    true
                }),
            )
            .expect("subscribe");

        // 4. project.add（容器内 git fixture 仓库）。
        let project = fx
            .manager
            .request(
                &profile.id,
                "project.add",
                json!({"path": "/home/ap/proj", "name": "e2e"}),
            )
            .expect("project.add");
        let project_id = project
            .get("projectId")
            .or_else(|| project.get("project").and_then(|p| p.get("id")))
            .or_else(|| project.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("project.add shape: {project}"))
            .to_string();
        println!("project_id={project_id}");

        // 5. session.create（Shell agent，落在 fixture 仓库）。
        let session = fx
            .manager
            .request(
                &profile.id,
                "session.create",
                json!({
                    "projectId": project_id,
                    "agent": "shell",
                    "permission": "auto",
                    "cols": 100,
                    "rows": 30,
                }),
            )
            .expect("session.create");
        let session_id = session
            .get("sessionId")
            .or_else(|| session.get("session").and_then(|s| s.get("id")))
            .or_else(|| session.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("session.create shape: {session}"))
            .to_string();
        println!("session_id={session_id}");

        // 6. attach（subscribe_output + screen_snapshot）。
        let attach = fx
            .manager
            .request(
                &profile.id,
                "session.attach",
                json!({
                    "sessionId": session_id,
                    "subscribeOutput": true,
                    "screenSnapshot": true,
                    "replayTailBytes": 65536,
                }),
            )
            .expect("session.attach");
        let attachment_id = attach
            .get("attachmentId")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("attach shape: {attach}"))
            .to_string();
        println!("attachment_id={attachment_id}");

        // 7. input 回显标记：终端事件流里必须出现 E2E_MARK_42。
        let marker = "E2E_MARK_42";
        let input = format!("echo {marker}$((40+2))\n");
        fx.manager
            .request(
                &profile.id,
                "session.input",
                json!({
                    "attachmentId": attachment_id,
                    "batchId": "e2e-batch-1",
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(input.as_bytes()),
                }),
            )
            .expect("session.input");
        let want = format!("{marker}42");
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut seen = false;
        while Instant::now() < deadline {
            let bytes = collect_output(&events);
            if bytes.windows(want.len()).any(|w| w == want.as_bytes()) {
                seen = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(seen, "terminal output must echo {want}");

        // 8. git 读 + 写：先经远程终端制造变更，changes 必须列出 a.txt，stage 后进入 staged 计数。
        fx.manager
            .request(
                &profile.id,
                "session.input",
                json!({
                    "attachmentId": attachment_id,
                    "batchId": "e2e-batch-2",
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(b"echo e2e-more >> /home/ap/proj/a.txt\n"),
                }),
            )
            .expect("session.input dirty");
        std::thread::sleep(Duration::from_millis(800));
        let locator = json!({"kind": "projectMain", "projectId": project_id});
        let changes = fx
            .manager
            .request(
                &profile.id,
                "git.changes",
                json!({"locator": locator, "includeIgnored": false}),
            )
            .expect("git.changes");
        let entry = changes
            .get("entries")
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries.iter().find(|e| {
                    e.get("path").and_then(Value::as_str) == Some("a.txt")
                        || e.get("displayPath").and_then(Value::as_str) == Some("a.txt")
                })
            })
            .unwrap_or_else(|| panic!("a.txt missing in changes: {changes}"))
            .clone();
        let selection = json!([{
            "pathToken": entry.get("pathToken").and_then(Value::as_str).expect("pathToken"),
            "entryToken": entry.get("entryToken").and_then(Value::as_str).expect("entryToken"),
        }]);
        let checkout_id = changes
            .get("context")
            .and_then(|c| c.get("checkoutId"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("checkoutId missing: {changes}"));
        let status_token = changes
            .get("statusToken")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("statusToken missing: {changes}"));
        fx.manager
            .request(
                &profile.id,
                "git.stage",
                json!({
                    "locator": locator,
                    "expectedCheckoutId": checkout_id,
                    "expectedStatusToken": status_token,
                    "selections": selection,
                }),
            )
            .expect("git.stage");
        let after = fx
            .manager
            .request(
                &profile.id,
                "git.changes",
                json!({"locator": locator, "includeIgnored": false}),
            )
            .expect("git.changes after stage");
        println!("after stage: {}", after.get("counts").unwrap_or(&Value::Null));
        let staged = after
            .get("counts")
            .and_then(|c| c.get("staged"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        assert!(staged >= 1, "stage must move a.txt into staged counts");

        // 9. 断开再重连（= 切走再切回）：远端会话必须仍在运行。
        fx.manager.disconnect(&profile.id);
        std::thread::sleep(Duration::from_millis(500));
        fx.manager.connect(&profile.id).expect("reconnect");
        let list = fx
            .manager
            .request(&profile.id, "session.list", json!({}))
            .expect("session.list after reconnect");
        let sessions_value = match list {
            Value::Array(arr) => arr,
            other => other
                .get("sessions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| panic!("session.list shape: {other}")),
        };
        let still_running = sessions_value.iter().any(|s| {
            s.get("id").and_then(Value::as_str) == Some(session_id.as_str())
                && s.get("hostAlive").and_then(Value::as_bool) == Some(true)
        });
        assert!(still_running, "remote session must survive disconnect/switch-away");
        fx.manager.disconnect(&profile.id);
        println!("ssh_full_stack_against_linux_container: PASS");
    }

    /// relay 全链路：redeem 配对 → connect（Noise over relay）→ hello/session.list。
    #[test]
    #[ignore = "requires a live invitation via AGENTPORT_E2E_INVITATION"]
    fn relay_pair_and_connect_against_linux_connector() {
        if !enabled() {
            return;
        }
        let invitation = std::env::var("AGENTPORT_E2E_INVITATION").expect("AGENTPORT_E2E_INVITATION");
        let fx = fixture();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let profile = runtime
            .block_on(async {
                let identity = fx.manager.identity().expect("identity");
                pairing::redeem_pairing(&identity, &invitation, Some("e2e-linux-relay".into())).await
            })
            .expect("redeem_pairing");
        assert!(profile.id.starts_with("dev_"));
        fx.registry.upsert(profile.clone()).expect("upsert");
        let hello = fx.manager.connect(&profile.id).expect("relay connect");
        println!("relay hello: {hello:?}");
        let list = fx
            .manager
            .request(&profile.id, "session.list", json!({}))
            .expect("session.list over relay");
        println!("relay session.list: {}", list.to_string().chars().take(200).collect::<String>());
        fx.manager.disconnect(&profile.id);
        println!("relay_pair_and_connect_against_linux_connector: PASS");
    }

    /// GUI 证据种子：在 AGENTPORT_E2E_DATA_DIR 里 redeem 邀请函、创建远程项目与
    /// Shell 会话并留一条可见输出，使调试 GUI 切到该设备后侧边栏/终端有真实内容。
    #[test]
    #[ignore = "requires AGENTPORT_E2E_INVITATION and AGENTPORT_E2E_DATA_DIR"]
    fn relay_seed_for_gui() {
        if !enabled() {
            return;
        }
        let invitation = std::env::var("AGENTPORT_E2E_INVITATION").expect("AGENTPORT_E2E_INVITATION");
        let root = std::path::PathBuf::from(
            std::env::var("AGENTPORT_E2E_DATA_DIR").expect("AGENTPORT_E2E_DATA_DIR"),
        );
        let fx = fixture_at(root, None);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let profile = runtime
            .block_on(async {
                let identity = fx.manager.identity().expect("identity");
                pairing::redeem_pairing(&identity, &invitation, Some("e2e-linux-relay".into())).await
            })
            .expect("redeem_pairing");
        fx.registry.upsert(profile.clone()).expect("upsert");
        fx.manager.connect(&profile.id).expect("connect");

        let events: Arc<SyncMutex<Vec<RemoteEventMsg>>> = Arc::new(SyncMutex::new(Vec::new()));
        let sink = events.clone();
        fx.manager
            .subscribe(
                &profile.id,
                Arc::new(move |msg: &RemoteEventMsg| {
                    sink.lock().unwrap().push(msg.clone());
                    true
                }),
            )
            .expect("subscribe");

        let project = fx
            .manager
            .request(&profile.id, "project.add", json!({"path": "/home/ap/proj", "name": "e2e"}))
            .expect("project.add");
        let project_id = project
            .get("projectId")
            .or_else(|| project.get("project").and_then(|p| p.get("id")))
            .or_else(|| project.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("project.add shape: {project}"))
            .to_string();
        let session = fx
            .manager
            .request(
                &profile.id,
                "session.create",
                json!({"projectId": project_id, "agent": "shell", "permission": "auto", "cols": 100, "rows": 30}),
            )
            .expect("session.create");
        let session_id = session
            .get("sessionId")
            .or_else(|| session.get("session").and_then(|s| s.get("id")))
            .or_else(|| session.get("id"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("session.create shape: {session}"))
            .to_string();
        let attach = fx
            .manager
            .request(
                &profile.id,
                "session.attach",
                json!({"sessionId": session_id, "subscribeOutput": true, "screenSnapshot": true, "replayTailBytes": 65536}),
            )
            .expect("session.attach");
        let attachment_id = attach
            .get("attachmentId")
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("attach shape: {attach}"))
            .to_string();
        fx.manager
            .request(
                &profile.id,
                "session.input",
                json!({
                    "attachmentId": attachment_id,
                    "batchId": "e2e-gui-seed-1",
                    "dataBase64": base64::engine::general_purpose::STANDARD.encode(b"echo GUI_SEED_MARK_$((6*7)) && echo remote-linux ready\n"),
                }),
            )
            .expect("session.input");
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut seen = false;
        while Instant::now() < deadline {
            if collect_output(&events)
                .windows(15)
                .any(|w| w == b"GUI_SEED_MARK_42")
            {
                seen = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        assert!(seen, "seed session must echo GUI_SEED_MARK_42");
        fx.manager.disconnect(&profile.id);
        println!("relay_seed_for_gui: PASS device={} session={session_id}", profile.id);
    }
}
