mod credentials;
mod hosts;
mod mosh;
mod remote;
mod sftp;
mod ssh;

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScaffoldStatus {
    app: &'static str,
    transport_ready: bool,
    note: &'static str,
}

/// The scaffold deliberately exposes no fake connection commands. T-017 adds
/// the transport plugin only after its iOS and Android gates pass.
#[tauri::command]
fn mobile_scaffold_status() -> ScaffoldStatus {
    ScaffoldStatus {
        app: "agentport-mobile",
        transport_ready: false,
        note: "transport spike not integrated",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_keyring_store::Builder::new()
                .service("com.agentport.mobile.credentials")
                .build(),
        )
        .manage(remote::RemoteConnections::default())
        .manage(mosh::MoshSessions::default());
    builder
        .invoke_handler(tauri::generate_handler![
            mobile_scaffold_status,
            hosts::mobile_list_host_profiles,
            hosts::mobile_get_host_profile,
            hosts::mobile_save_host_profile,
            hosts::mobile_copy_host_profile,
            hosts::mobile_trust_host_key,
            hosts::mobile_delete_host_profile,
            hosts::mobile_export_host_profiles,
            hosts::mobile_import_host_profiles,
            credentials::mobile_store_credential,
            credentials::mobile_generate_ed25519_credential,
            credentials::mobile_import_private_key_credential,
            credentials::mobile_delete_credential,
            credentials::mobile_secure_storage_status,
            ssh::mobile_probe_ssh_bridge,
            remote::mobile_connect_host,
            remote::mobile_disconnect_host,
            remote::mobile_remote_request,
            remote::mobile_subscribe,
            remote::mobile_unsubscribe,
            sftp::mobile_sftp_spike,
            mosh::bootstrap::mobile_mosh_bootstrap_start,
            mosh::mobile_mosh_start,
            mosh::mobile_mosh_input,
            mosh::mobile_mosh_resize,
            mosh::mobile_mosh_poll,
            mosh::mobile_mosh_stop,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AgentPort Mobile");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scaffold_does_not_claim_transport_support() {
        let status = mobile_scaffold_status();
        assert!(!status.transport_ready);
    }
}
