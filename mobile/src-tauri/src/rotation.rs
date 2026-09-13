/// Per-screen rotation authority for the mobile app.
///
/// The primary interface stays portrait (the 4703d61 contract) while the
/// terminal route releases the lock so xterm geometry can follow the device
/// orientation (SES-07/TERM-02). iOS cannot express this with the bundle's
/// `UISupportedInterfaceOrientations` alone — that plist applies to every
/// screen, which is how df6fe42 re-opened the primary screen while restoring
/// the terminal. Instead the Tao view controller's runtime orientation mask
/// is driven by the terminal route, the same seam the immersive status bar
/// uses. Android mirrors it by toggling the activity's requested orientation.
#[tauri::command]
pub async fn mobile_set_terminal_rotation(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    rotation_allowed: bool,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = &app;
        use objc2::{class, msg_send, runtime::AnyObject, sel};
        let (send, receive) = tokio::sync::oneshot::channel();
        // with_webview executes on the UI thread and keeps the native view alive.
        webview.with_webview(move |platform| {
            let result = unsafe {
                let controller = platform.view_controller().cast::<AnyObject>();
                if controller.is_null() {
                    Err("Missing iOS view controller".to_string())
                } else {
                    // Tao declares this property on TaoUIViewController. Guard it so
                    // an upstream controller change fails safely, not by crash.
                    let supported: bool = msg_send![controller, respondsToSelector: sel!(setSupportedInterfaceOrientations:)];
                    if !supported {
                        Err("iOS controller does not support orientation mask".to_string())
                    } else {
                        // UIDevice is never nil in a running app; a nil read yields
                        // 0 (Phone), which takes the locked path.
                        let device: *mut AnyObject = msg_send![class!(UIDevice), currentDevice];
                        let idiom: std::ffi::c_long = msg_send![device, userInterfaceIdiom];
                        // UIUserInterfaceIdiomPad == 1 (tao 0.35 ffi.rs).
                        match ios_orientation_mask(rotation_allowed, idiom == 1) {
                            Some(mask) => {
                                let _: () = msg_send![controller, setSupportedInterfaceOrientations: mask];
                                Ok(())
                            }
                            // The iPad primary screen keeps the accepted all-orientation
                            // behavior (4703d61 only ever locked the iPhone plist).
                            None => Ok(()),
                        }
                    }
                }
            };
            let _ = send.send(result);
        }).map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())?
    }
    #[cfg(target_os = "android")]
    {
        let _ = &webview;
        use tauri::Manager;
        app.state::<tauri_plugin_screen_rotation::ScreenRotation<tauri::Wry>>()
            .set_rotation_allowed(rotation_allowed)
            .await
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (app, webview, rotation_allowed);
        Ok(())
    }
}

/// UIKit `UIInterfaceOrientationMask` bit values (tao 0.35 ffi.rs).
#[cfg(any(target_os = "ios", test))]
const IOS_PORTRAIT_MASK: usize = 1 << 1;
#[cfg(any(target_os = "ios", test))]
const IOS_PORTRAIT_UPSIDE_DOWN_MASK: usize = 1 << 2;
#[cfg(any(target_os = "ios", test))]
const IOS_LANDSCAPE_MASK: usize = (1 << 4) | (1 << 3);

/// iPhone: the terminal restores tao's launch default (rotate), the primary
/// interface locks to portrait. iPad: the terminal restores `All`; the
/// primary is left untouched.
#[cfg(any(target_os = "ios", test))]
fn ios_orientation_mask(rotation_allowed: bool, pad: bool) -> Option<usize> {
    match (rotation_allowed, pad) {
        (true, false) => Some(IOS_LANDSCAPE_MASK | IOS_PORTRAIT_MASK),
        (true, true) => Some(IOS_LANDSCAPE_MASK | IOS_PORTRAIT_MASK | IOS_PORTRAIT_UPSIDE_DOWN_MASK),
        (false, false) => Some(IOS_PORTRAIT_MASK),
        (false, true) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::ios_orientation_mask;

    #[test]
    fn iphone_primary_locks_portrait_and_terminal_restores_rotation() {
        assert_eq!(ios_orientation_mask(false, false), Some(2));
        assert_eq!(ios_orientation_mask(true, false), Some(2 | 8 | 16));
    }

    #[test]
    fn ipad_primary_is_left_untouched_and_terminal_restores_all() {
        assert_eq!(ios_orientation_mask(false, true), None);
        assert_eq!(ios_orientation_mask(true, true), Some(2 | 4 | 8 | 16));
    }
}
