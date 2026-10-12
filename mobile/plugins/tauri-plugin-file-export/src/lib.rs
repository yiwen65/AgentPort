use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_file_export);

#[derive(Deserialize)]
pub struct ExportResult {
    pub status: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportArgs<'a> {
    path: String,
    name: &'a str,
    job_id: &'a str,
}

pub struct FileExport<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> FileExport<R> {
    /// Internal-only API. The source must be the exact file owned by a download
    /// job below the application's private cache, not an arbitrary JS path.
    pub async fn export(
        &self,
        owned_root: &Path,
        source: &Path,
        name: &str,
        job_id: &str,
    ) -> Result<ExportResult, String> {
        let root = owned_root
            .canonicalize()
            .map_err(|_| "export_source_unavailable")?;
        let file = source
            .canonicalize()
            .map_err(|_| "export_source_unavailable")?;
        if file != root.join(job_id).join(name) || !file.is_file() {
            return Err("export_source_invalid".into());
        }
        self.0
            .run_mobile_plugin_async(
                "exportFile",
                ExportArgs {
                    path: file.to_str().ok_or("export_source_invalid")?.to_owned(),
                    name,
                    job_id,
                },
            )
            .await
            .map_err(|_| "save_failed".into())
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("file-export")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            let handle =
                api.register_android_plugin("com.agentport.fileexport", "FileExportPlugin")?;
            #[cfg(target_os = "ios")]
            let handle = api.register_ios_plugin(init_plugin_file_export)?;
            app.manage(FileExport(handle));
            Ok(())
        })
        .build()
}
