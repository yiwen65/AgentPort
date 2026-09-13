use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Manager, Runtime};

/// Android handle for the screen-rotation plugin. The primary interface keeps
/// the activity's portrait default; the terminal route releases the lock so
/// the terminal can follow the device orientation.
pub struct ScreenRotation<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> ScreenRotation<R> {
    pub async fn set_rotation_allowed(&self, rotation_allowed: bool) -> Result<(), String> {
        self.0
            .run_mobile_plugin_async::<serde_json::Value>(
                "setRotationAllowed",
                serde_json::json!({ "rotationAllowed": rotation_allowed }),
            )
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("screen-rotation").setup(|app, api| {
        #[cfg(target_os = "android")]
        {
            let handle = api.register_android_plugin("com.agentport.screenrotation", "ScreenRotationPlugin")?;
            app.manage(ScreenRotation(handle));
        }
        Ok(())
    }).build()
}
