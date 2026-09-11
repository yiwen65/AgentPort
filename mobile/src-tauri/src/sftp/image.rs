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
        let (generation, ssh) = connections.image_upload_connection(&profile_id).await?;
        let picked = app.state::<tauri_plugin_image_picker::ImagePicker<tauri::Wry>>().pick().await?;
        let Some(path) = picked else { return Ok(None); };
        let image = CachedImage(PathBuf::from(path));
        if !connections.image_upload_connection_is_current(&profile_id, &generation).await {
            return Err("The SSH connection changed. Please select the image again.".into());
        }
        let channel = tokio::time::timeout(Duration::from_secs(10), ssh.session.channel_open_session())
            .await.map_err(|_| "SFTP connection timed out.")?.map_err(|_| "Unable to open SFTP on the current SSH connection.")?;
        tokio::time::timeout(Duration::from_secs(10), channel.request_subsystem(true, "sftp"))
            .await.map_err(|_| "SFTP connection timed out.")?.map_err(|_| "This SSH server does not provide SFTP.")?;
        let sftp = tokio::time::timeout(Duration::from_secs(10), SftpSession::new(channel.into_stream()))
            .await.map_err(|_| "SFTP connection timed out.")?.map_err(|_| "Unable to start SFTP.")?;
        let result = upload_image_file(&sftp, &image.0).await;
        let _ = tokio::time::timeout(Duration::from_secs(2), sftp.close()).await;
        let remote = result?;
        if !connections.image_upload_connection_is_current(&profile_id, &generation).await {
            return Err("The SSH connection changed; the uploaded path was not inserted.".into());
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
