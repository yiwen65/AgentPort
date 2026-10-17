/// iOS fullscreen geometry alone does not hide the status bar in Tao. Update
/// the app-owned TaoUIViewController preference instead (not UIApplication's
/// deprecated global status-bar API). Android uses the route's native display
/// plugin to hide system bars without changing IME visibility.
#[tauri::command]
pub async fn mobile_set_terminal_immersive(
    app: tauri::AppHandle,
    webview: tauri::WebviewWindow,
    immersive: bool,
) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let _ = &app;
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
                        let _: () = msg_send![controller, setNeedsStatusBarAppearanceUpdate];
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
    #[cfg(target_os = "android")]
    {
        let _ = &webview;
        use tauri::Manager;
        app.state::<tauri_plugin_screen_rotation::ScreenRotation<tauri::Wry>>()
            .set_immersive(immersive)
            .await
    }
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (app, webview, immersive);
        Ok(())
    }
}
