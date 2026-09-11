pub mod image;

use crate::credentials::load_credential;
use crate::ssh::{connect_authenticated_with_jump, validate, AuthenticatedSsh, SshProbeRequest};
use base64::Engine as _;
use russh::Disconnect;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::OpenFlags;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::Zeroizing;

const MAX_TRANSFER_BYTES: usize = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES: usize = 2_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SftpSpikeRequest {
    connection: SshProbeRequest,
    operation: SftpOperation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SftpOperation {
    List {
        path: String,
    },
    Download {
        path: String,
    },
    AtomicUpload {
        path: String,
        content_base64: String,
    },
    CreateDirectory {
        path: String,
    },
    RemoveFile {
        path: String,
    },
    RemoveDirectory {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Chmod {
        path: String,
        mode: u32,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpSpikeResult {
    host_key_fingerprint: String,
    result: Value,
}

fn validate_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') || path.len() > 4096 || path.contains('\0') {
        return Err("SFTP path must be a bounded absolute path".into());
    }
    Ok(())
}

fn atomic_temp_path(path: &str) -> Result<String, String> {
    validate_path(path)?;
    let (parent, name) = path
        .rsplit_once('/')
        .ok_or_else(|| "SFTP upload path is invalid".to_string())?;
    if name.is_empty() || name == "." || name == ".." {
        return Err("SFTP upload path is invalid".into());
    }
    let parent = if parent.is_empty() { "/" } else { parent };
    Ok(format!(
        "{}/.{}.agentport-upload-{}",
        parent.trim_end_matches('/'),
        name,
        uuid::Uuid::new_v4().simple()
    ))
}

fn sftp_error(_: impl std::fmt::Debug) -> String {
    "SFTP operation failed".into()
}

#[tauri::command]
pub async fn mobile_sftp_spike(
    app: AppHandle,
    request: SftpSpikeRequest,
) -> Result<SftpSpikeResult, String> {
    validate(&request.connection)?;
    let secret = load_credential(&app, &request.connection.credential_id)?;
    let jump_secret = request
        .connection
        .jump
        .as_ref()
        .map(|jump| load_credential(&app, &jump.credential_id))
        .transpose()?;
    run_sftp(request, secret, jump_secret).await
}

async fn run_sftp(
    request: SftpSpikeRequest,
    secret: Zeroizing<Vec<u8>>,
    jump_secret: Option<Zeroizing<Vec<u8>>>,
) -> Result<SftpSpikeResult, String> {
    let AuthenticatedSsh {
        session,
        host_key_fingerprint,
        jump_session: _jump_session,
    } = connect_authenticated_with_jump(
        &request.connection,
        secret.as_slice(),
        jump_secret.as_ref().map(|value| value.as_slice()),
    )
    .await
    .map_err(|failure| failure.reason.to_string())?;
    let channel = session.channel_open_session().await.map_err(sftp_error)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(sftp_error)?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(sftp_error)?;

    let result = match request.operation {
        SftpOperation::List { path } => {
            validate_path(&path)?;
            let entries = sftp.read_dir(path).await.map_err(sftp_error)?;
            let mut output = Vec::new();
            for entry in entries.take(MAX_DIRECTORY_ENTRIES) {
                let metadata = entry.metadata();
                output.push(json!({
                    "name": entry.file_name(),
                    "path": entry.path(),
                    "size": metadata.size,
                    "permissions": metadata.permissions,
                    "isDirectory": metadata.is_dir(),
                    "isSymlink": metadata.is_symlink()
                }));
            }
            json!({"entries": output})
        }
        SftpOperation::Download { path } => {
            validate_path(&path)?;
            let file = sftp.open(path).await.map_err(sftp_error)?;
            let mut content = Zeroizing::new(Vec::new());
            file.take((MAX_TRANSFER_BYTES + 1) as u64)
                .read_to_end(&mut content)
                .await
                .map_err(sftp_error)?;
            if content.len() > MAX_TRANSFER_BYTES {
                return Err("SFTP download exceeds the spike transfer limit".into());
            }
            let digest = format!("{:x}", Sha256::digest(content.as_slice()));
            json!({
                "bytes": content.len(),
                "sha256": digest,
                "contentBase64": base64::engine::general_purpose::STANDARD.encode(content.as_slice())
            })
        }
        SftpOperation::AtomicUpload {
            path,
            content_base64,
        } => {
            let temp_path = atomic_temp_path(&path)?;
            if content_base64.len() > MAX_TRANSFER_BYTES.saturating_mul(2) {
                return Err("SFTP upload exceeds the spike transfer limit".into());
            }
            let content = Zeroizing::new(
                base64::engine::general_purpose::STANDARD
                    .decode(content_base64)
                    .map_err(|_| "SFTP upload content is invalid".to_string())?,
            );
            if content.len() > MAX_TRANSFER_BYTES {
                return Err("SFTP upload exceeds the spike transfer limit".into());
            }
            let upload_result = async {
                let mut file = sftp
                    .open_with_flags(
                        temp_path.clone(),
                        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                    )
                    .await
                    .map_err(sftp_error)?;
                file.write_all(content.as_slice())
                    .await
                    .map_err(sftp_error)?;
                file.sync_all().await.map_err(sftp_error)?;
                file.shutdown().await.map_err(sftp_error)?;
                sftp.rename(temp_path.clone(), path)
                    .await
                    .map_err(sftp_error)
            }
            .await;
            if let Err(error) = upload_result {
                let _ = sftp.remove_file(temp_path).await;
                return Err(error);
            }
            json!({
                "bytes": content.len(),
                "sha256": format!("{:x}", Sha256::digest(content.as_slice())),
                "atomic": true
            })
        }
        SftpOperation::CreateDirectory { path } => {
            validate_path(&path)?;
            sftp.create_dir(path).await.map_err(sftp_error)?;
            json!({"created": true})
        }
        SftpOperation::RemoveFile { path } => {
            validate_path(&path)?;
            sftp.remove_file(path).await.map_err(sftp_error)?;
            json!({"removed": true})
        }
        SftpOperation::RemoveDirectory { path } => {
            validate_path(&path)?;
            sftp.remove_dir(path).await.map_err(sftp_error)?;
            json!({"removed": true})
        }
        SftpOperation::Rename { from, to } => {
            validate_path(&from)?;
            validate_path(&to)?;
            sftp.rename(from, to).await.map_err(sftp_error)?;
            json!({"renamed": true})
        }
        SftpOperation::Chmod { path, mode } => {
            validate_path(&path)?;
            if mode > 0o7777 {
                return Err("SFTP mode is invalid".into());
            }
            let mut metadata = sftp.metadata(path.clone()).await.map_err(sftp_error)?;
            let file_type = metadata.permissions.unwrap_or(0) & !0o7777;
            metadata.permissions = Some(file_type | mode);
            sftp.set_metadata(path, metadata)
                .await
                .map_err(sftp_error)?;
            json!({"changed": true, "mode": mode})
        }
    };

    let _ = session
        .disconnect(Disconnect::ByApplication, "SFTP spike complete", "en")
        .await;
    Ok(SftpSpikeResult {
        host_key_fingerprint,
        result,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_absolute_and_atomic_temp_stays_with_sibling() {
        assert!(validate_path("relative/file").is_err());
        assert!(validate_path("/safe/file").is_ok());
        let temp = atomic_temp_path("/safe/file.txt").unwrap();
        assert!(temp.starts_with("/safe/.file.txt.agentport-upload-"));
        assert!(atomic_temp_path("/").is_err());
    }

    #[cfg(target_os = "macos")]
    struct SshdGuard(std::process::Child);

    #[cfg(target_os = "macos")]
    impl Drop for SshdGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn real_openssh_sftp_fixture_atomically_uploads_and_downloads() {
        use crate::ssh::AuthenticationKind;
        use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
        use std::os::unix::fs::PermissionsExt;
        use std::process::{Command, Stdio};

        let root = std::env::temp_dir().join(format!(
            "agentport-mobile-sftp-fixture-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let client_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
        let host_key_path = root.join("host_key");
        let authorized_keys_path = root.join("authorized_keys");
        let config_path = root.join("sshd_config");
        std::fs::write(
            &host_key_path,
            host_key.to_openssh(LineEnding::LF).unwrap().as_bytes(),
        )
        .unwrap();
        std::fs::write(
            &authorized_keys_path,
            format!("{}\n", client_key.public_key().to_openssh().unwrap()),
        )
        .unwrap();
        std::fs::set_permissions(&host_key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::set_permissions(
            &authorized_keys_path,
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let port = {
            let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            socket.local_addr().unwrap().port()
        };
        let username = std::env::var("USER").unwrap();
        std::fs::write(
            &config_path,
            format!(
                "HostKey {}\nPort {}\nListenAddress 127.0.0.1\nPidFile {}/sshd.pid\nAuthorizedKeysFile {}\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nSubsystem sftp internal-sftp -d {}\nLogLevel ERROR\n",
                host_key_path.display(),
                port,
                root.display(),
                authorized_keys_path.display(),
                root.display()
            ),
        )
        .unwrap();
        let child = Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(&config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let guard = SshdGuard(child);
        for _ in 0..50 {
            if tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .is_ok()
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        let fingerprint = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let private_key = Zeroizing::new(
            client_key
                .to_openssh(LineEnding::LF)
                .unwrap()
                .as_bytes()
                .to_vec(),
        );
        let connection = || SshProbeRequest {
            host_profile_id: "host_sftp_fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: username.clone(),
            credential_id: "lease_sftp_fixture".into(),
            authentication: AuthenticationKind::PrivateKey,
            expected_host_key: Some(fingerprint.clone()),
            jump: None,
        };
        let target = root.join("payload.bin").to_string_lossy().into_owned();
        let payload = b"AgentPort atomic SFTP fixture";
        let upload = run_sftp(
            SftpSpikeRequest {
                connection: connection(),
                operation: SftpOperation::AtomicUpload {
                    path: target.clone(),
                    content_base64: base64::engine::general_purpose::STANDARD.encode(payload),
                },
            },
            Zeroizing::new(private_key.to_vec()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(upload.result["atomic"], true);
        assert_eq!(std::fs::read(&target).unwrap(), payload);
        assert!(std::fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("agentport-upload")));

        let download = run_sftp(
            SftpSpikeRequest {
                connection: connection(),
                operation: SftpOperation::Download {
                    path: target.clone(),
                },
            },
            Zeroizing::new(private_key.to_vec()),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(download.result["contentBase64"].as_str().unwrap())
                .unwrap(),
            payload
        );

        // Keep one authenticated SSH and a live PTY while opening a temporary
        // SFTP subsystem. Its home is the isolated fixture root, not the user's.
        let ssh = connect_authenticated_with_jump(&connection(), private_key.as_slice(), None).await.map_err(|failure| failure.reason).unwrap();
        let mut pty = ssh.session.channel_open_session().await.unwrap();
        pty.request_pty(true, "xterm", 80, 24, 0, 0, &[]).await.unwrap();
        pty.exec(true, "read value; printf 'AFTER_%s' \"$value\"").await.unwrap();
        let channel = ssh.session.channel_open_session().await.unwrap();
        channel.request_subsystem(true, "sftp").await.unwrap();
        let sftp = SftpSession::new(channel.into_stream()).await.unwrap();
        for (bytes, extension) in [(&b"\x89PNG\r\n\x1a\nfixture"[..], ".png"), (&b"\xff\xd8\xff\xe0JPEG fixture"[..], ".jpg")] {
            let local = root.join("picked-image");
            std::fs::write(&local, bytes).unwrap();
            let remote = image::upload_image_file(&sftp, &local).await.unwrap();
            // Agent image readers open this path directly, without shell tilde expansion.
            let uploaded = std::path::PathBuf::from(&remote);
            assert!(uploaded.is_absolute(), "Agent image path must be absolute: {remote}");
            assert_eq!(uploaded.parent().unwrap(), root.canonicalize().unwrap().join(".cache/agentport"));
            assert!(uploaded.file_name().unwrap().to_str().unwrap().starts_with("image-"));
            assert!(remote.ends_with(extension));
            assert_eq!(std::fs::read(&uploaded).unwrap(), bytes);
            assert_eq!(std::fs::metadata(uploaded).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let invalid = root.join("unsupported");
        std::fs::write(&invalid, b"GIF89a unsupported").unwrap();
        assert!(image::upload_image_file(&sftp, &invalid).await.unwrap_err().contains("PNG and JPEG"));
        assert_eq!(std::fs::read_dir(root.join(".cache/agentport")).unwrap().count(), 2);
        sftp.close().await.unwrap();
        pty.data(&b"image-upload-ok\n"[..]).await.unwrap();
        let output = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            let mut output = Vec::new();
            while let Some(message) = pty.wait().await {
                if let russh::ChannelMsg::Data { data } = message { output.extend_from_slice(&data); }
            }
            output
        }).await.unwrap();
        assert!(String::from_utf8_lossy(&output).contains("AFTER_image-upload-ok"));
        ssh.session.disconnect(Disconnect::ByApplication, "fixture complete", "en").await.unwrap();
        drop(guard);
        std::fs::remove_dir_all(root).unwrap();
    }
}
