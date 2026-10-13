mod appearance;
mod markdown_images;
mod file_download;
mod relay_pairing;
mod credentials;
mod hosts;
mod generic_terminal;
mod ios_push;
mod mosh;
mod remote;
mod rotation;
mod sftp;
mod ssh;

use serde::Serialize;
use tauri::Manager;

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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_keyring_store::Builder::new()
                .service("com.agentport.mobile.credentials")
                .build(),
        )
        .manage(remote::RemoteConnections::default())
        .manage(relay_pairing::RelayPairings::default())
        .manage(mosh::MoshSessions::default())
        .manage(generic_terminal::TerminalConnections::default())
        .setup(|app| {
            // iOS already has an app-private sandbox cache. Tauri's
            // app_cache_dir adds the bundle ID; use cache_dir to match UIKit.
            #[cfg(target_os = "ios")]
            let download_cache = app.path().cache_dir();
            #[cfg(not(target_os = "ios"))]
            let download_cache = app.path().app_cache_dir();
            app.manage(file_download::FileDownloads::initialize(download_cache));
            #[cfg(target_os = "ios")]
            ios_push::install(app.handle());
            Ok(())
        });
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init())
        .plugin(tauri_plugin_image_picker::init())
        .plugin(tauri_plugin_file_export::init());
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_screen_rotation::init());
    builder
        .invoke_handler(tauri::generate_handler![
            mobile_scaffold_status,
            markdown_images::markdown_image_fetch,
            markdown_images::markdown_image_validate,
            file_download::mobile_file_download_start,
            file_download::mobile_file_download_poll,
            file_download::mobile_file_download_cancel,
            file_download::mobile_file_download_save,
            file_download::mobile_file_download_discard,
            generic_terminal::mobile_terminal_list,
            generic_terminal::mobile_terminal_create,
            generic_terminal::mobile_terminal_connect,
            generic_terminal::mobile_terminal_input,
            generic_terminal::mobile_terminal_resize,
            generic_terminal::mobile_terminal_poll,
            generic_terminal::mobile_terminal_disconnect,
            generic_terminal::mobile_terminal_end,
            ios_push::mobile_push_register,
            ios_push::mobile_push_take_state,
            ios_push::mobile_push_ack_tap,
            relay_pairing::mobile_relay_pairing_preview,
            relay_pairing::mobile_relay_pairing_prepare,
            relay_pairing::mobile_relay_pairing_begin,
            relay_pairing::mobile_relay_pairing_wait,
            relay_pairing::mobile_relay_pairing_cancel,
            relay_pairing::mobile_relay_pairing_reconcile,
            appearance::mobile_set_terminal_immersive,
            rotation::mobile_set_terminal_rotation,
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
            remote::mobile_remote_submit_input,
            remote::mobile_register_push_token,
            remote::mobile_subscribe,
            remote::mobile_unsubscribe,
            sftp::mobile_sftp_spike,
            sftp::image::mobile_upload_image,
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
