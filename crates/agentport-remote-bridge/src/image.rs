use agentport_remote_protocol::image::{MAX_CHUNK_BYTES, MAX_IMAGE_BYTES};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

struct Upload {
    id: String,
    path: PathBuf,
    file: File,
    size: u64,
    offset: u64,
    extension: String,
    digest: Sha256,
    started: Instant,
    complete: bool,
}
impl Drop for Upload {
    fn drop(&mut self) {
        if !self.complete {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

pub(super) struct ImageUploads {
    home: Option<PathBuf>,
    active: Option<Upload>,
}
impl ImageUploads {
    pub(super) fn new() -> Self {
        Self {
            home: std::env::var_os("HOME").map(PathBuf::from),
            active: None,
        }
    }

    pub(super) fn request(
        &mut self,
        method: &str,
        params: &Value,
        bytes: &[u8],
    ) -> Result<Value, String> {
        if self
            .active
            .as_ref()
            .is_some_and(|u| u.started.elapsed().as_secs() > 120)
        {
            self.active = None;
        }
        if method == "image.begin" {
            if self.active.is_some() {
                return Err("An image upload is already in progress.".into());
            }
            let size = params["size"]
                .as_u64()
                .filter(|size| *size > 0 && *size <= MAX_IMAGE_BYTES)
                .ok_or("Image must be between 1 byte and 20 MiB.")?;
            let extension = params["extension"]
                .as_str()
                .filter(|ext| matches!(*ext, "png" | "jpg"))
                .ok_or("Only PNG and JPEG images are supported.")?;
            let home = self
                .home
                .as_ref()
                .filter(|home| home.is_absolute())
                .ok_or("Remote home directory is unavailable.")?;
            let directory = home.join(".cache/agentport");
            std::fs::create_dir_all(&directory).map_err(|_| "Unable to create image cache.")?;
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "Invalid remote clock.")?
                .as_nanos();
            let id = format!("{}-{timestamp}", std::process::id());
            let path = directory.join(format!("image-{id}.{extension}"));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options
                .open(&path)
                .map_err(|_| "Unable to create image file.")?;
            self.active = Some(Upload {
                id: id.clone(),
                path,
                file,
                size,
                offset: 0,
                extension: extension.into(),
                digest: Sha256::new(),
                started: Instant::now(),
                complete: false,
            });
            return Ok(json!({"uploadId": id}));
        }
        let id = params["uploadId"]
            .as_str()
            .ok_or("Missing image upload identifier.")?;
        if !self.active.as_ref().is_some_and(|u| u.id == id) {
            return Err("Image upload is no longer available.".into());
        }
        if method == "image.abort" {
            self.active = None;
            return Ok(json!({"aborted": true}));
        }
        let mut upload = self.active.take().unwrap();
        match method {
            "image.chunk" => {
                if bytes.is_empty()
                    || bytes.len() > MAX_CHUNK_BYTES
                    || params["offset"].as_u64() != Some(upload.offset)
                    || upload.offset + bytes.len() as u64 > upload.size
                {
                    return Err("Invalid image chunk offset or size.".into());
                }
                if upload.offset == 0 {
                    let valid = match upload.extension.as_str() {
                        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
                        _ => bytes.starts_with(&[255, 216, 255]),
                    };
                    if !valid {
                        return Err("Image content does not match PNG/JPEG format.".into());
                    }
                }
                upload
                    .file
                    .write_all(bytes)
                    .map_err(|_| "Image upload write failed.")?;
                upload.digest.update(bytes);
                upload.offset += bytes.len() as u64;
                let offset = upload.offset;
                self.active = Some(upload);
                Ok(json!({"offset": offset}))
            }
            "image.finish" => {
                let digest = format!("{:x}", upload.digest.clone().finalize());
                if upload.offset != upload.size || params["sha256"].as_str() != Some(&digest) {
                    return Err("Image upload length or digest mismatch.".into());
                }
                upload
                    .file
                    .flush()
                    .map_err(|_| "Unable to finish image upload.")?;
                upload.complete = true;
                Ok(json!({"path": upload.path.to_string_lossy()}))
            }
            _ => Err("Unknown image upload method.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_upload_validates_bytes_and_cleans_failures() {
        let root = std::env::temp_dir().join(format!(
            "agentport-relay-image-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut uploads = ImageUploads {
            home: Some(root.clone()),
            active: None,
        };
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let begin = || json!({"size": bytes.len(), "extension": "png"});
        assert!(uploads
            .request(
                "image.begin",
                &json!({"size": MAX_IMAGE_BYTES + 1, "extension": "png"}),
                &[]
            )
            .is_err());
        assert!(uploads
            .request(
                "image.begin",
                &json!({"size": 12, "extension": "../other"}),
                &[]
            )
            .is_err());
        let id = uploads.request("image.begin", &begin(), &[]).unwrap()["uploadId"].clone();
        assert!(uploads.request("image.begin", &begin(), &[]).is_err());
        assert!(uploads
            .request(
                "image.abort",
                &json!({"uploadId": "another-connection"}),
                &[]
            )
            .is_err());
        uploads
            .request("image.chunk", &json!({"uploadId": id, "offset": 0}), bytes)
            .unwrap();
        let result = uploads
            .request(
                "image.finish",
                &json!({"uploadId": id, "sha256": format!("{:x}", Sha256::digest(bytes))}),
                &[],
            )
            .unwrap();
        let path = PathBuf::from(result["path"].as_str().unwrap());
        assert!(path.is_absolute());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        for method in ["image.abort", "image.finish", "image.chunk"] {
            let id = uploads.request("image.begin", &begin(), &[]).unwrap()["uploadId"].clone();
            let result = uploads.request(
                method,
                &json!({"uploadId": id, "offset": 999, "sha256": "bad"}),
                bytes,
            );
            assert_eq!(result.is_ok(), method == "image.abort");
            assert!(uploads.active.is_none());
        }
        let id = uploads.request("image.begin", &begin(), &[]).unwrap()["uploadId"].clone();
        assert!(uploads
            .request(
                "image.chunk",
                &json!({"uploadId": id, "offset": 0}),
                b"GIF89a invalid"
            )
            .is_err());
        let id = uploads.request("image.begin", &begin(), &[]).unwrap()["uploadId"].clone();
        uploads
            .request("image.chunk", &json!({"uploadId": id, "offset": 0}), bytes)
            .unwrap();
        assert!(uploads
            .request(
                "image.finish",
                &json!({"uploadId": id, "sha256": "incorrect"}),
                &[]
            )
            .is_err());
        let id = uploads.request("image.begin", &begin(), &[]).unwrap()["uploadId"].clone();
        uploads.active.as_mut().unwrap().started =
            Instant::now() - std::time::Duration::from_secs(121);
        assert!(uploads
            .request("image.chunk", &json!({"uploadId": id, "offset": 0}), bytes)
            .is_err());
        uploads.request("image.begin", &begin(), &[]).unwrap();
        drop(uploads);
        assert_eq!(
            std::fs::read_dir(root.join(".cache/agentport"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
