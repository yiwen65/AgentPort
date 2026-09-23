//! APNs is an OS-visible, best-effort hint. The authenticated attention inbox
//! remains the source of truth; token registration and tap routing are handled
//! by the paired Relay/UI layers, never by the push payload itself.

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTap {
    pub host_id: String,
    pub session_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushState {
    pub token: Option<String>,
    pub permission: String,
    pub environment: String,
    pub pending_tap: Option<PushTap>,
}

#[cfg(target_os = "ios")]
mod native {
    use super::PushState;
    use std::{
        ffi::{c_char, CStr},
        sync::{Mutex, OnceLock},
    };
    use tauri::{AppHandle, Emitter};

    type PermissionCallback = extern "C" fn(i32);
    static APP: OnceLock<AppHandle> = OnceLock::new();
    // Only one in-flight authorization request at a time. iOS may call its
    // completion handler on a background thread; never hold a lock into FFI.
    static AUTH_REQUEST: Mutex<Option<tokio::sync::oneshot::Sender<i32>>> = Mutex::new(None);

    unsafe extern "C" {
        fn agentport_push_install(callback: extern "C" fn(*const c_char));
        fn agentport_push_request_authorization(callback: PermissionCallback);
        fn agentport_push_take_state() -> *mut c_char;
        fn agentport_push_ack_tap(host_id: *const c_char, session_id: *const c_char);
    }

    extern "C" fn on_push_event(json: *const c_char) {
        if json.is_null() {
            return;
        }
        let Ok(raw) = (unsafe { CStr::from_ptr(json) }).to_str() else {
            return;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
            return;
        };
        let Some(name) = value.get("event").and_then(|event| event.as_str()) else {
            return;
        };
        if !matches!(
            name,
            "mobile-push-token" | "mobile-push-tap" | "mobile-push-received"
        ) {
            return;
        }
        if let (Some(app), Some(payload)) = (APP.get(), value.get("payload")) {
            let _ = app.emit(name, payload);
        }
    }

    extern "C" fn authorization_completed(status: i32) {
        if let Some(sender) = AUTH_REQUEST.lock().unwrap().take() {
            let _ = sender.send(status);
        }
    }

    pub fn install(app: &AppHandle) {
        let _ = APP.set(app.clone());
        // Installs APNs selectors on Tao's existing UIApplicationDelegate;
        // also re-registers on app launch if notifications are already allowed.
        unsafe { agentport_push_install(on_push_event) }
    }

    pub fn take_state() -> Result<PushState, String> {
        let ptr = unsafe { agentport_push_take_state() };
        if ptr.is_null() {
            return Err("Unable to read iOS push state".into());
        }
        let value = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe {
            libc::free(ptr.cast());
        }
        serde_json::from_str(&value).map_err(|error| error.to_string())
    }

    pub fn ack_tap(tap: &super::PushTap) -> Result<(), String> {
        let host =
            std::ffi::CString::new(tap.host_id.as_str()).map_err(|error| error.to_string())?;
        let session =
            std::ffi::CString::new(tap.session_id.as_str()).map_err(|error| error.to_string())?;
        unsafe { agentport_push_ack_tap(host.as_ptr(), session.as_ptr()) };
        Ok(())
    }

    pub async fn register() -> Result<String, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        {
            let mut current = AUTH_REQUEST.lock().map_err(|error| error.to_string())?;
            if current.is_some() {
                return Err("Push authorization already in progress".into());
            }
            *current = Some(sender);
        }
        unsafe { agentport_push_request_authorization(authorization_completed) };
        let status = receiver.await.map_err(|error| error.to_string())?;
        let permission = match status {
            0 => "notDetermined",
            1 => "denied",
            2 => "authorized",
            3 => "provisional",
            4 => "ephemeral",
            _ => return Err("iOS notification authorization failed".into()),
        };
        // Token delivery is asynchronous; callers read state or listen for
        // mobile-push-token instead of treating authorization as APNs delivery.
        Ok(permission.into())
    }
}

#[cfg(target_os = "ios")]
pub fn install(app: &tauri::AppHandle) {
    native::install(app);
}

#[tauri::command]
pub async fn mobile_push_register() -> Result<String, String> {
    #[cfg(target_os = "ios")]
    {
        native::register().await
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err("APNs is only available on iOS".into())
    }
}

/// Reads a pending tap without consuming it; JS acknowledges only after it
/// has checked the authenticated host and session. Tokens remain available
/// across webview reloads.
#[tauri::command]
pub fn mobile_push_take_state() -> Result<PushState, String> {
    #[cfg(target_os = "ios")]
    {
        native::take_state()
    }
    #[cfg(not(target_os = "ios"))]
    {
        Err("APNs is only available on iOS".into())
    }
}

#[tauri::command]
pub fn mobile_push_ack_tap(tap: PushTap) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        native::ack_tap(&tap)
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = tap;
        Err("APNs is only available on iOS".into())
    }
}

#[cfg(test)]
mod tests {
    use super::PushState;

    #[test]
    fn native_state_contract_has_no_notification_body() {
        let state: PushState = serde_json::from_str(r#"{"token":"aabb","permission":"authorized","environment":"sandbox","pendingTap":{"hostId":"host","sessionId":"session"}}"#).unwrap();
        assert_eq!(state.pending_tap.unwrap().session_id, "session");
    }
}
