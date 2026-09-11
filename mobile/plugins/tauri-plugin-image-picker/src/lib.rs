use serde::Deserialize;
use tauri::{plugin::{Builder, PluginHandle, TauriPlugin}, Manager, Runtime};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_image_picker);

#[derive(Deserialize)]
pub struct PickedImage {
    pub path: Option<String>,
}

pub struct ImagePicker<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> ImagePicker<R> {
    pub async fn pick(&self) -> Result<Option<String>, String> {
        self.0.run_mobile_plugin_async::<PickedImage>("pickImage", ())
            .await.map(|image| image.path).map_err(|error| error.to_string())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("image-picker").setup(|app, api| {
        #[cfg(target_os = "android")]
        let handle = api.register_android_plugin("com.agentport.imagepicker", "ImagePickerPlugin")?;
        #[cfg(target_os = "ios")]
        let handle = api.register_ios_plugin(init_plugin_image_picker)?;
        app.manage(ImagePicker(handle));
        Ok(())
    }).build()
}
