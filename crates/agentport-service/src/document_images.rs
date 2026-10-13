//! Desktop document-root image streams. The caller supplies the browsing root,
//! unlike Session downloads whose root always comes from the server database.
//! Separate registries prevent handles crossing those two access surfaces.
use crate::session_files::{downloads::Downloads, SessionFilesError};
use serde::Deserialize;
use serde_json::Value;

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenParams {
    root_path: String,
    path: String,
}

#[derive(Default)]
pub(crate) struct Images {
    downloads: Downloads,
}

impl Images {
    pub(crate) fn execute(&self, method: &str, params: Value) -> Result<Value, SessionFilesError> {
        match method {
            "document.images.open" => {
                let params: OpenParams =
                    serde_json::from_value(params).map_err(|_| SessionFilesError::InvalidPath)?;
                self.downloads
                    .open_bounded(&params.root_path, &params.path, MAX_IMAGE_BYTES)
                    .map_err(|error| match error {
                        SessionFilesError::FileTooLarge => SessionFilesError::ImageTooLarge,
                        other => other,
                    })
            }
            "document.images.chunk" => self
                .downloads
                .execute("session.files.download.chunk", params),
            "document.images.finish" => self
                .downloads
                .execute("session.files.download.finish", params),
            "document.images.close" => self
                .downloads
                .execute("session.files.download.close", params),
            _ => Err(SessionFilesError::InvalidDownload),
        }
    }
}

#[cfg(all(test, unix))]
#[path = "document_images_tests.rs"]
mod tests;
