//! Thin Tauri command wrappers over `RemoteConnectionManager`.
//! All blocking work runs inside `spawn_blocking`; these functions are the
//! only place in the remote module that touches Tauri runtime types.

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::Manager;

use crate::remote::{
    DeviceAddSshDraft, DeviceProfile, DeviceRegistry, RemoteCommandError, RemoteConnectionManager,
    RemoteEventMsg, RemoteHello,
};

#[tauri::command]
pub async fn remote_connect(
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    device_id: String,
) -> Result<RemoteHello, RemoteCommandError> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.connect(&device_id))
        .await
        .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))?
}

#[tauri::command]
pub async fn remote_disconnect(
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    device_id: String,
) -> Result<(), RemoteCommandError> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.disconnect(&device_id);
    })
    .await
    .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))?;
    Ok(())
}

#[tauri::command]
pub async fn remote_request(
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    device_id: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, RemoteCommandError> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.request(&device_id, &method, params))
        .await
        .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))?
}

#[tauri::command]
pub async fn remote_subscribe(
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    device_id: String,
    channel: Channel<RemoteEventMsg>,
) -> Result<(), RemoteCommandError> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.subscribe(
            &device_id,
            Arc::new(move |msg| channel.send(msg.clone()).is_ok()),
        )
    })
    .await
    .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))?
}

/// Lists every registered device (secret-free profiles only).
#[tauri::command]
pub async fn device_list(
    registry: tauri::State<'_, Arc<DeviceRegistry>>,
) -> Result<Vec<DeviceProfile>, RemoteCommandError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.list())
        .await
        .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))
}

/// Probe-first SSH onboarding: proves reachability, authentication, host-key
/// trust and protocol compatibility BEFORE persisting anything, then stores
/// the secret in the platform keychain and the profile in the registry.
#[tauri::command]
pub async fn device_add_ssh(
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    registry: tauri::State<'_, Arc<DeviceRegistry>>,
    draft: DeviceAddSshDraft,
) -> Result<DeviceProfile, RemoteCommandError> {
    let manager = manager.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        registry.add_ssh_device(manager.ssh_prober().as_ref(), draft)
    })
    .await
    .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))?
}

/// Removes a device: live connection first, then the profile, then (when
/// requested) the keychain credential. Server-side authorization revocation
/// for relay devices happens on the controlled machine, not here.
#[tauri::command]
pub async fn device_remove(
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    registry: tauri::State<'_, Arc<DeviceRegistry>>,
    device_id: String,
    delete_credentials: bool,
) -> Result<(), RemoteCommandError> {
    let manager = manager.inner().clone();
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.disconnect(&device_id);
        let removed = registry.remove(&device_id)?;
        if delete_credentials
            && matches!(
                removed.transport,
                crate::remote::types::DeviceTransportProfile::Ssh { .. }
            )
        {
            registry.credentials().delete(&device_id)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))?
}

#[tauri::command]
pub async fn device_rename(
    registry: tauri::State<'_, Arc<DeviceRegistry>>,
    device_id: String,
    name: String,
) -> Result<(), RemoteCommandError> {
    let registry = registry.inner().clone();
    tauri::async_runtime::spawn_blocking(move || registry.rename(&device_id, &name))
        .await
        .map_err(|error| RemoteCommandError::new("join_failed", error.to_string()))?
}

/// Redeems a controlled PC's one-time pairing payload into a PERSISTED local
/// device profile (registry upsert happens only after the pairing itself
/// succeeded on the wire).
#[tauri::command]
pub async fn device_pair_redeem(
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    registry: tauri::State<'_, Arc<DeviceRegistry>>,
    payload: String,
    name: Option<String>,
) -> Result<DeviceProfile, RemoteCommandError> {
    let manager = manager.inner().clone();
    let registry = registry.inner().clone();
    let profile = manager.redeem_pairing(&payload, name).await?;
    registry.upsert(profile.clone())?;
    Ok(profile)
}

/// Serializes THIS desktop's own one-time pairing invitation as copyable
/// text (the same Invitation JSON the phone QR encodes). Drives the existing
/// connector: starts it if needed and asks for an automatic invitation.
#[tauri::command]
pub async fn device_pairing_link(
    state: tauri::State<'_, crate::AppState>,
    relay: tauri::State<'_, crate::relay::DesktopRelay>,
) -> Result<String, RemoteCommandError> {
    crate::relay::invite_automatic_text(state.paths.root(), &relay)
        .await
        .map_err(|message| RemoteCommandError::new("pairing_link_failed", message))
}

/// Fires a LOCAL macOS notification for one remote-device attention item
/// (frontend `attention.poll` cycle). Gates mirror the local pipeline:
/// device still connected → synthesize the equivalent StatusEvent → shared
/// NotificationDeduper → notifier enabled → ≤30s fresh → not the focused
/// Session. The local worker's DB checks do not apply (a remote Session has
/// no local row); the poll cursor already guarantees recency ordering.
/// Returns true when a system notification was emitted.
#[tauri::command]
pub async fn remote_attention_notify(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    manager: tauri::State<'_, Arc<RemoteConnectionManager>>,
    input: crate::remote::attention_notify::RemoteAttentionNotificationInput,
) -> Result<bool, RemoteCommandError> {
    use crate::remote::attention_notify::{
        attention_notification_title, attention_notify_allowed, synthesize_attention_event,
    };
    if !manager.is_connected(&input.device_id) {
        return Ok(false);
    }
    let Some(event) = synthesize_attention_event(&input) else {
        return Ok(false);
    };
    let (enabled, language) = {
        let notifier = state.notifier.lock().unwrap();
        (notifier.enabled(), notifier.language())
    };
    let allowed = {
        let mut deduper = state.notification_deduper.lock().unwrap();
        attention_notify_allowed(&mut deduper, enabled, &event, chrono::Utc::now())
    };
    if !allowed {
        return Ok(false);
    }
    let selected = state.notification_session.lock().unwrap().clone();
    let window_focused = app
        .get_webview_window("main")
        .is_some_and(|window| window.is_focused().unwrap_or(false));
    if agentport_core::notification_policy::is_focused_target(
        &event,
        selected.as_deref(),
        window_focused,
    ) {
        return Ok(false);
    }
    let title = attention_notification_title(&input);
    let Some(notification) =
        agentport_core::notify::notification_for_state_change(language, &title, &event)
    else {
        return Ok(false);
    };
    crate::notifications::send(&notification)
        .map_err(|error| RemoteCommandError::new("notification_failed", error.to_string()))?;
    Ok(true)
}
