use russh::keys::ssh_key::{Algorithm, LineEnding, PrivateKey};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_keyring_store::KeyringExt;
use zeroize::Zeroizing;

const ACCOUNT_PREFIX: &str = "credential:";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CredentialWriteRequest {
    secret: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivateKeyImportRequest {
    private_key: Zeroizing<String>,
    #[serde(default)]
    passphrase: Option<Zeroizing<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialHandle {
    credential_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyHandle {
    credential_id: String,
    public_key: String,
}

fn account(credential_id: &str) -> Result<String, String> {
    if credential_id.len() > 128
        || !credential_id.starts_with("cred_")
        || !credential_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '_' || value == '-')
    {
        return Err("invalid credential handle".into());
    }
    Ok(format!("{ACCOUNT_PREFIX}{credential_id}"))
}

pub(crate) fn store_secret(app: &AppHandle, secret: &[u8]) -> Result<String, String> {
    if secret.is_empty() || secret.len() > 1024 * 1024 {
        return Err("credential length is invalid".into());
    }
    let credential_id = format!("cred_{}", uuid::Uuid::new_v4().simple());
    app.keyring()
        .store
        .set_bytes(&account(&credential_id)?, secret)
        .map_err(|_| "secure credential storage is unavailable".to_string())?;
    Ok(credential_id)
}

#[tauri::command]
pub fn mobile_store_credential(
    app: AppHandle,
    request: CredentialWriteRequest,
) -> Result<CredentialHandle, String> {
    Ok(CredentialHandle {
        credential_id: store_secret(&app, request.secret.as_bytes())?,
    })
}

#[tauri::command]
pub fn mobile_generate_ed25519_credential(app: AppHandle) -> Result<SshKeyHandle, String> {
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|_| "Ed25519 key generation failed".to_string())?;
    let encoded = key
        .to_openssh(LineEnding::LF)
        .map_err(|_| "Ed25519 key encoding failed".to_string())?;
    let public_key = key
        .public_key()
        .to_openssh()
        .map_err(|_| "Ed25519 public key encoding failed".to_string())?;
    Ok(SshKeyHandle {
        credential_id: store_secret(&app, encoded.as_bytes())?,
        public_key,
    })
}

#[tauri::command]
pub fn mobile_import_private_key_credential(
    app: AppHandle,
    request: PrivateKeyImportRequest,
) -> Result<SshKeyHandle, String> {
    if request.private_key.is_empty() || request.private_key.len() > 1024 * 1024 {
        return Err("private key length is invalid".into());
    }
    let parsed = PrivateKey::from_openssh(request.private_key.as_bytes())
        .map_err(|_| "private key is invalid".to_string())?;
    let key = if parsed.is_encrypted() {
        let passphrase = request
            .passphrase
            .as_ref()
            .ok_or_else(|| "private key passphrase is required".to_string())?;
        parsed
            .decrypt(passphrase.as_bytes())
            .map_err(|_| "private key decryption failed".to_string())?
    } else {
        parsed
    };
    let encoded = key
        .to_openssh(LineEnding::LF)
        .map_err(|_| "private key encoding failed".to_string())?;
    let public_key = key
        .public_key()
        .to_openssh()
        .map_err(|_| "public key encoding failed".to_string())?;
    Ok(SshKeyHandle {
        credential_id: store_secret(&app, encoded.as_bytes())?,
        public_key,
    })
}

#[tauri::command]
pub fn mobile_delete_credential(app: AppHandle, credential_id: String) -> Result<(), String> {
    app.keyring()
        .store
        .delete(&account(&credential_id)?)
        .map_err(|_| "secure credential deletion failed".to_string())
}

#[tauri::command]
pub fn mobile_secure_storage_status(app: AppHandle) -> String {
    format!("{:?}", app.keyring().store.availability())
}

pub fn load_credential(app: &AppHandle, credential_id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    app.keyring()
        .store
        .get_bytes(&account(credential_id)?)
        .map_err(|_| "secure credential retrieval failed".to_string())?
        .map(Zeroizing::new)
        .ok_or_else(|| "credential was not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_handles_reject_paths_and_accounts() {
        assert!(account("cred_safe-1").is_ok());
        assert!(account("../../unsafe").is_err());
        assert!(account("cred_bad/slash").is_err());
    }
}
