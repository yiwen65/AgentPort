use russh_sftp::{client::SftpSession, protocol::{FileAttributes, OpenFlags}};
use std::{path::{Path, PathBuf}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

struct CachedImage(PathBuf);
impl Drop for CachedImage {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

fn image_extension(header: &[u8]) -> Result<&'static str, String> {
    if header.starts_with(b"\x89PNG\r\n\x1a\n") { Ok("png") }
    else if header.starts_with(&[0xff, 0xd8, 0xff]) { Ok("jpg") }
    else { Err("Only PNG and JPEG images are supported.".into()) }
}

async fn ensure_directory(sftp: &SftpSession, path: &str) -> Result<(), String> {
    match sftp.create_dir(path).await {
        Ok(()) => Ok(()),
        Err(_) if sftp.metadata(path).await.is_ok_and(|metadata| metadata.is_dir()) => Ok(()),
        Err(_) => Err("Unable to create the remote image cache directory.".into()),
    }
}

/// Upload raw bytes; SFTP paths do not expand '~', so resolve the subsystem's
/// initial (login-home) directory. Return the absolute path: Agent image readers
/// open pasted paths directly and need not perform shell tilde expansion.
pub(super) async fn upload_image_file(sftp: &SftpSession, local: &Path) -> Result<String, String> {
    let mut input = tokio::fs::File::open(local).await.map_err(|_| "Unable to read the selected image.")?;
    let mut header = [0; 8];
    let count = input.read(&mut header).await.map_err(|_| "Unable to read the selected image.")?;
    let extension = image_extension(&header[..count])?;
    input.rewind().await.map_err(|_| "Unable to read the selected image.")?;
    let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Device clock is invalid.")?.as_nanos();
    let filename = format!("image-{timestamp}.{extension}");
    let home = tokio::time::timeout(Duration::from_secs(10), sftp.canonicalize("."))
        .await.map_err(|_| "SFTP request timed out.")?.map_err(|_| "Unable to resolve the remote home directory.")?;
    let cache = format!("{}/.cache", home.trim_end_matches('/'));
    let directory = format!("{cache}/agentport");
    let remote = format!("{directory}/{filename}");
    let mut created = false;
    let result = tokio::time::timeout(Duration::from_secs(120), async {
        ensure_directory(sftp, &cache).await?;
        ensure_directory(sftp, &directory).await?;
        let mut output = sftp.open_with_flags(&remote, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
            .await.map_err(|_| "Unable to create the remote image file.")?;
        created = true;
        output.set_metadata(FileAttributes { permissions: Some(0o600), ..Default::default() })
            .await.map_err(|_| "Unable to set image file permissions.")?;
        tokio::io::copy(&mut input, &mut output).await.map_err(|_| "Image upload failed.")?;
        output.shutdown().await.map_err(|_| "Unable to finish the image upload.")?;
        Ok::<_, String>(remote.clone())
    }).await.unwrap_or_else(|_| Err("Image upload timed out. Please try again.".into()));
    if result.is_err() && created {
        let _ = tokio::time::timeout(Duration::from_secs(5), sftp.remove_file(remote)).await;
    }
    result
}

pub(crate) async fn upload_relay_image<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    connections: &crate::remote::RemoteConnections,
    profile_id: &str,
    relay: &crate::remote::RelayImageConnection,
    local: &Path,
) -> Result<String, String> {
    use agentport_remote_protocol::image::{MAX_CHUNK_BYTES, MAX_IMAGE_BYTES};
    use serde_json::json;
    use sha2::{Digest, Sha256};
    let mut file = tokio::fs::File::open(local).await.map_err(|_| "Unable to read the selected image.")?;
    let size = file.metadata().await.map_err(|_| "Unable to read image size.")?.len();
    if size == 0 || size > MAX_IMAGE_BYTES { return Err("Relay images must be between 1 byte and 20 MiB.".into()); }
    let mut header = [0; 8];
    let count = file.read(&mut header).await.map_err(|_| "Unable to read the selected image.")?;
    let extension = image_extension(&header[..count])?;
    file.rewind().await.map_err(|_| "Unable to read the selected image.")?;
    let begin = relay.request(app, connections, profile_id, "image.begin", json!({"size": size, "extension": extension}), None).await?;
    let id = begin["uploadId"].as_str().ok_or("Invalid image upload response.")?;
    let result = async {
        let mut bytes = vec![0; MAX_CHUNK_BYTES];
        let mut offset = 0_u64;
        let mut digest = Sha256::new();
        let started = std::time::Instant::now();
        loop {
            if started.elapsed() > Duration::from_secs(120) { return Err("Image upload timed out.".into()); }
            let count = file.read(&mut bytes).await.map_err(|_| "Unable to read the selected image.")?;
            if count == 0 { break; }
            let ack = relay.request(app, connections, profile_id, "image.chunk", json!({"uploadId": id, "offset": offset}), Some(&bytes[..count])).await?;
            offset += count as u64;
            if ack["offset"].as_u64() != Some(offset) { return Err("Invalid image upload acknowledgement.".into()); }
            digest.update(&bytes[..count]);
        }
        if offset != size { return Err("The selected image changed during upload.".into()); }
        let finish = relay.request(app, connections, profile_id, "image.finish", json!({"uploadId": id, "sha256": format!("{:x}", digest.finalize())}), None).await?;
        let path = finish["path"].as_str().filter(|path| path.starts_with('/')).ok_or("Invalid uploaded image path.")?;
        Ok::<String, String>(path.to_owned())
    }.await;
    if result.is_err() {
        let _ = relay.request(app, connections, profile_id, "image.abort", json!({"uploadId": id}), None).await;
    }
    result
}

#[tauri::command]
pub async fn mobile_upload_image(
    app: tauri::AppHandle,
    connections: tauri::State<'_, crate::remote::RemoteConnections>,
    profile_id: String,
) -> Result<Option<String>, String> {
    #[cfg(not(mobile))]
    { let _ = (app, connections, profile_id); Err("Image selection is available on iOS and Android only.".into()) }
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let (generation, transport) = connections.image_upload_connection(&profile_id).await?;
        let picked = app.state::<tauri_plugin_image_picker::ImagePicker<tauri::Wry>>().pick().await?;
        let Some(path) = picked else { return Ok(None); };
        let image = CachedImage(PathBuf::from(path));
        if !connections.image_upload_connection_is_current(&profile_id, &generation).await {
            return Err("The host connection changed. Please select the image again.".into());
        }
        let remote = match transport {
        crate::remote::ImageUploadConnection::Relay(relay) => upload_relay_image(&app, &connections, &profile_id, &relay, &image.0).await?,
        crate::remote::ImageUploadConnection::Ssh(ssh) => {
        let channel = tokio::time::timeout(Duration::from_secs(10), ssh.session.channel_open_session())
            .await.map_err(|_| "SFTP connection timed out.")?.map_err(|_| "Unable to open SFTP on the current SSH connection.")?;
        tokio::time::timeout(Duration::from_secs(10), channel.request_subsystem(true, "sftp"))
            .await.map_err(|_| "SFTP connection timed out.")?.map_err(|_| "This SSH server does not provide SFTP.")?;
        let sftp = tokio::time::timeout(Duration::from_secs(10), SftpSession::new(channel.into_stream()))
            .await.map_err(|_| "SFTP connection timed out.")?.map_err(|_| "Unable to start SFTP.")?;
        let result = upload_image_file(&sftp, &image.0).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.close()).await;
        result?
        }
        };
        if !connections.image_upload_connection_is_current(&profile_id, &generation).await {
            return Err("The host connection changed; the uploaded path was not inserted.".into());
        }
        Ok(Some(remote))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_supported_bytes_instead_of_trusting_picker_filename() {
        assert_eq!(image_extension(b"\x89PNG\r\n\x1a\n").unwrap(), "png");
        assert_eq!(image_extension(&[0xff, 0xd8, 0xff, 0xe0]).unwrap(), "jpg");
        for invalid in [&b"GIF89a"[..], &b"\0\0\0\x18ftypheic"[..], &b""[..], &b"\x89PNG"[..]] {
            assert!(image_extension(invalid).is_err());
        }
    }

    #[test]
    fn releases_picker_cache_on_success_or_early_error() {
        let path = std::env::temp_dir().join(format!("agentport-image-test-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"temporary").unwrap();
        { let _guard = CachedImage(path.clone()); }
        assert!(!path.exists());
    }
}
