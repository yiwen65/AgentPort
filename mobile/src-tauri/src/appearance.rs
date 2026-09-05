/// iOS fullscreen geometry alone does not hide the status bar in Tao. Update
/// the app-owned TaoUIViewController preference instead (not UIApplication's
/// deprecated global status-bar API). Other platforms retain their system UI.
#[tauri::command]
pub async fn mobile_set_terminal_immersive(
    webview: tauri::WebviewWindow,
    immersive: bool,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        use objc2::{msg_send, runtime::AnyObject, sel};
        let (send, receive) = tokio::sync::oneshot::channel();
        // with_webview executes on the UI thread and keeps the native view alive.
        webview.with_webview(move |platform| {
            let result = unsafe {
                let controller = platform.view_controller().cast::<AnyObject>();
                if controller.is_null() {
                    Err("Missing iOS view controller".to_string())
                } else {
                    // This setter is provided by Tao, not by UIKit. Guard it so
                    // an upstream controller change fails safely, not by crash.
                    let supported: bool = msg_send![controller, respondsToSelector: sel!(setPrefersStatusBarHidden:)];
                    if supported {
                        let _: () = msg_send![controller, setPrefersStatusBarHidden: immersive];
                        Ok(())
                    } else {
                        Err("iOS controller does not support status-bar visibility".to_string())
                    }
                }
            };
            let _ = send.send(result);
        }).map_err(|error| error.to_string())?;
        receive.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (webview, immersive);
        Ok(())
    }
}
