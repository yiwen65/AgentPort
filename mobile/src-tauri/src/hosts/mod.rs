use aes_gcm::aead::consts::U12;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use rand::RngExt as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

const PROFILE_FILE: &str = "host-profiles-v1.json";
const TRUST_FILE: &str = "host-trust-v1.json";
const MAX_PROFILES: usize = 256;
const EXPORT_FORMAT: &str = "agentport-host-profiles";
const EXPORT_VERSION: u8 = 1;
const EXPORT_AAD: &[u8] = b"agentport-host-profiles-v1";
const MAX_EXPORT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PreferredTransport {
    Ssh,
    Mosh,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthenticationKind {
    Password,
    PrivateKey,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JumpProfile {
    pub host_profile_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostProfile {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub preferred_transport: PreferredTransport,
    pub authentication: AuthenticationKind,
    pub credential_id: String,
    #[serde(default)]
    pub jump: Option<JumpProfile>,
    #[serde(default)]
    pub mosh_udp_port_start: Option<u16>,
    #[serde(default)]
    pub mosh_udp_port_end: Option<u16>,
    pub enabled: bool,
    pub sort_order: i32,
    #[serde(default)]
    pub trusted_host_key: Option<String>,
    #[serde(default)]
    pub last_connected_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_known_summary: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfileSummary {
    id: String,
    name: String,
    hostname: String,
    port: u16,
    username: String,
    preferred_transport: PreferredTransport,
    connection_state: &'static str,
    last_connected_at: Option<String>,
    last_error: Option<String>,
    enabled: bool,
    stale: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveHostProfileRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub hostname: String,
    pub port: u16,
    pub username: String,
    pub preferred_transport: PreferredTransport,
    pub authentication: AuthenticationKind,
    pub credential_id: String,
    #[serde(default)]
    pub jump: Option<JumpProfile>,
    #[serde(default)]
    pub mosh_udp_port_start: Option<u16>,
    #[serde(default)]
    pub mosh_udp_port_end: Option<u16>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteHostProfileRequest {
    pub profile_id: String,
    #[serde(default)]
    pub delete_credential: bool,
    #[serde(default)]
    pub delete_trust: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteHostProfileResult {
    pub credential_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportProfilesRequest {
    passphrase: Zeroizing<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportProfilesRequest {
    document: Zeroizing<String>,
    passphrase: Zeroizing<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProfilesResult {
    imported_count: usize,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EncryptedProfileDocument {
    format: String,
    version: u8,
    kdf: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportProfile {
    id: String,
    name: String,
    hostname: String,
    port: u16,
    username: String,
    preferred_transport: PreferredTransport,
    authentication: AuthenticationKind,
    jump: Option<JumpProfile>,
    mosh_udp_port_start: Option<u16>,
    mosh_udp_port_end: Option<u16>,
    enabled: bool,
    sort_order: i32,
}

fn default_enabled() -> bool {
    true
}

fn data_path(app: &AppHandle, file: &str) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|root| root.join(file))
        .map_err(|_| "host profile storage is unavailable".into())
}

fn profile_path(app: &AppHandle) -> Result<PathBuf, String> {
    data_path(app, PROFILE_FILE)
}

fn trust_path(app: &AppHandle) -> Result<PathBuf, String> {
    data_path(app, TRUST_FILE)
}

fn trust_endpoint(hostname: &str, port: u16) -> String {
    format!("[{}]:{port}", hostname.trim().to_ascii_lowercase())
}

fn read_trust(path: &Path) -> Result<HashMap<String, String>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "host trust storage is invalid".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(_) => Err("host trust storage is unavailable".into()),
    }
}

fn read_profiles(path: &Path) -> Result<Vec<HostProfile>, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| "host profile storage is invalid".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(_) => Err("host profile storage is unavailable".into()),
    }
}

fn write_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| "host profile storage is unavailable")?;
    }
    let bytes = serde_json::to_vec(value).map_err(|_| "host profiles could not be saved")?;
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|_| "host profiles could not be saved")?;
    let result = (|| {
        file.write_all(&bytes)
            .map_err(|_| "host profiles could not be saved")?;
        file.sync_all()
            .map_err(|_| "host profiles could not be saved")?;
        fs::rename(&temp, path).map_err(|_| "host profiles could not be saved")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn write_profiles(path: &Path, profiles: &[HostProfile]) -> Result<(), String> {
    write_json(path, profiles)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.bytes().any(|byte| byte == 0)
}

fn validate_request(request: &SaveHostProfileRequest) -> Result<(), String> {
    if !valid_text(&request.name, 128)
        || !valid_text(&request.hostname, 253)
        || request.port == 0
        || !valid_text(&request.username, 128)
        || !valid_text(&request.credential_id, 128)
        || request
            .id
            .as_deref()
            .is_some_and(|value| !value.starts_with("host_") || !valid_text(value, 96))
    {
        return Err("invalid host profile".into());
    }
    match (request.mosh_udp_port_start, request.mosh_udp_port_end) {
        (None, None) => {}
        (Some(start), Some(end)) if start > 0 && start <= end => {}
        _ => return Err("invalid Mosh UDP port range".into()),
    }
    if request
        .jump
        .as_ref()
        .is_some_and(|jump| !jump.host_profile_id.starts_with("host_"))
    {
        return Err("invalid jump host profile".into());
    }
    Ok(())
}

#[tauri::command]
pub fn mobile_list_host_profiles(app: AppHandle) -> Result<Vec<HostProfileSummary>, String> {
    let mut profiles = read_profiles(&profile_path(&app)?)?;
    profiles.sort_by_key(|profile| (profile.sort_order, profile.name.to_lowercase()));
    Ok(profiles
        .into_iter()
        .map(|profile| HostProfileSummary {
            id: profile.id,
            name: profile.name,
            hostname: profile.hostname,
            port: profile.port,
            username: profile.username,
            preferred_transport: profile.preferred_transport,
            connection_state: if profile.enabled {
                "disconnected"
            } else {
                "stale"
            },
            stale: profile.last_connected_at.is_some(),
            last_connected_at: profile.last_connected_at,
            last_error: profile.last_error,
            enabled: profile.enabled,
        })
        .collect())
}

pub(crate) fn get_profile(app: &AppHandle, profile_id: &str) -> Result<HostProfile, String> {
    read_profiles(&profile_path(app)?)?
        .into_iter()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "host profile was not found".to_string())
}

#[tauri::command]
pub fn mobile_get_host_profile(app: AppHandle, profile_id: String) -> Result<HostProfile, String> {
    get_profile(&app, &profile_id)
}

#[tauri::command]
pub fn mobile_save_host_profile(
    app: AppHandle,
    request: SaveHostProfileRequest,
) -> Result<HostProfile, String> {
    validate_request(&request)?;
    let path = profile_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    let existing = request
        .id
        .as_ref()
        .and_then(|id| profiles.iter().position(|profile| profile.id == *id));
    if existing.is_none() && profiles.len() >= MAX_PROFILES {
        return Err("too many host profiles".into());
    }
    let old = existing.map(|index| profiles[index].clone());
    let endpoint = trust_endpoint(&request.hostname, request.port);
    let trusted_for_endpoint = read_trust(&trust_path(&app)?)?.get(&endpoint).cloned();
    let profile = HostProfile {
        id: request
            .id
            .unwrap_or_else(|| format!("host_{}", uuid::Uuid::new_v4().simple())),
        name: request.name.trim().to_string(),
        hostname: request.hostname.trim().to_string(),
        port: request.port,
        username: request.username.trim().to_string(),
        preferred_transport: request.preferred_transport,
        authentication: request.authentication,
        credential_id: request.credential_id,
        jump: request.jump,
        mosh_udp_port_start: request.mosh_udp_port_start,
        mosh_udp_port_end: request.mosh_udp_port_end,
        enabled: request.enabled,
        sort_order: request.sort_order,
        trusted_host_key: old
            .as_ref()
            .filter(|value| trust_endpoint(&value.hostname, value.port) == endpoint)
            .and_then(|value| value.trusted_host_key.clone())
            .or(trusted_for_endpoint),
        last_connected_at: old
            .as_ref()
            .and_then(|value| value.last_connected_at.clone()),
        last_error: old.as_ref().and_then(|value| value.last_error.clone()),
        last_known_summary: old.and_then(|value| value.last_known_summary),
    };
    if profile
        .jump
        .as_ref()
        .is_some_and(|jump| jump.host_profile_id == profile.id)
    {
        return Err("a host cannot use itself as a jump host".into());
    }
    if let Some(index) = existing {
        profiles[index] = profile.clone();
    } else {
        profiles.push(profile.clone());
    }
    write_profiles(&path, &profiles)?;
    Ok(profile)
}

#[tauri::command]
pub fn mobile_copy_host_profile(app: AppHandle, profile_id: String) -> Result<HostProfile, String> {
    let path = profile_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    if profiles.len() >= MAX_PROFILES {
        return Err("too many host profiles".into());
    }
    let source = profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| "host profile was not found".to_string())?;
    let mut copy = source;
    copy.id = format!("host_{}", uuid::Uuid::new_v4().simple());
    copy.name = format!("{} copy", copy.name);
    copy.trusted_host_key = None;
    copy.last_connected_at = None;
    copy.last_error = None;
    copy.last_known_summary = None;
    copy.sort_order = profiles
        .iter()
        .map(|profile| profile.sort_order)
        .max()
        .unwrap_or(0)
        + 1;
    profiles.push(copy.clone());
    write_profiles(&path, &profiles)?;
    Ok(copy)
}

#[tauri::command]
pub fn mobile_trust_host_key(
    app: AppHandle,
    profile_id: String,
    fingerprint: String,
) -> Result<(), String> {
    if !fingerprint.starts_with("SHA256:") || fingerprint.len() > 128 {
        return Err("invalid host key fingerprint".into());
    }
    let path = profile_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    let profile = profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
        .ok_or_else(|| "host profile was not found".to_string())?;
    let endpoint = trust_endpoint(&profile.hostname, profile.port);
    profile.trusted_host_key = Some(fingerprint.clone());
    profile.last_error = None;
    write_profiles(&path, &profiles)?;
    let trust_path = trust_path(&app)?;
    let mut trust = read_trust(&trust_path)?;
    trust.insert(endpoint, fingerprint);
    write_json(&trust_path, &trust)
}

#[tauri::command]
pub fn mobile_delete_host_profile(
    app: AppHandle,
    request: DeleteHostProfileRequest,
) -> Result<DeleteHostProfileResult, String> {
    let path = profile_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    let index = profiles
        .iter()
        .position(|profile| profile.id == request.profile_id)
        .ok_or_else(|| "host profile was not found".to_string())?;
    if profiles.iter().any(|profile| {
        profile
            .jump
            .as_ref()
            .is_some_and(|jump| jump.host_profile_id == request.profile_id)
    }) {
        return Err("host profile is still used as a jump host".into());
    }
    if request.delete_credential {
        let credential_id = &profiles[index].credential_id;
        if profiles.iter().enumerate().any(|(other_index, profile)| {
            other_index != index && profile.credential_id == *credential_id
        }) {
            return Err("credential is still used by another host profile".into());
        }
    }
    let removed = profiles.remove(index);
    let endpoint = trust_endpoint(&removed.hostname, removed.port);
    write_profiles(&path, &profiles)?;
    let trust_path = trust_path(&app)?;
    let mut trust = read_trust(&trust_path)?;
    if request.delete_trust {
        trust.remove(&endpoint);
    } else if let Some(fingerprint) = removed.trusted_host_key.clone() {
        trust.insert(endpoint, fingerprint);
    }
    write_json(&trust_path, &trust)?;
    Ok(DeleteHostProfileResult {
        credential_id: request.delete_credential.then_some(removed.credential_id),
    })
}

fn derive_export_key(passphrase: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    if passphrase.len() < 8 || passphrase.len() > 1024 {
        return Err("export passphrase must contain at least 8 characters".into());
    }
    let params = Params::new(19_456, 2, 1, Some(32))
        .map_err(|_| "profile export encryption is unavailable")?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; 32]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|_| "profile export encryption failed")?;
    Ok(key)
}

#[tauri::command]
pub fn mobile_export_host_profiles(
    app: AppHandle,
    request: ExportProfilesRequest,
) -> Result<String, String> {
    let profiles = read_profiles(&profile_path(&app)?)?;
    let export: Vec<ExportProfile> = profiles
        .into_iter()
        .map(|profile| ExportProfile {
            id: profile.id,
            name: profile.name,
            hostname: profile.hostname,
            port: profile.port,
            username: profile.username,
            preferred_transport: profile.preferred_transport,
            authentication: profile.authentication,
            jump: profile.jump,
            mosh_udp_port_start: profile.mosh_udp_port_start,
            mosh_udp_port_end: profile.mosh_udp_port_end,
            enabled: profile.enabled,
            sort_order: profile.sort_order,
        })
        .collect();
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&export).map_err(|_| "host profiles could not be exported")?,
    );
    if plaintext.len() > MAX_EXPORT_BYTES {
        return Err("host profile export is too large".into());
    }
    let mut salt = [0_u8; 16];
    let mut nonce_bytes = [0_u8; 12];
    rand::rng().fill(&mut salt);
    rand::rng().fill(&mut nonce_bytes);
    let mut key = derive_export_key(&request.passphrase, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "profile export encryption failed")?;
    let nonce: &Nonce<U12> = nonce_bytes
        .as_slice()
        .try_into()
        .map_err(|_| "profile export encryption failed")?;
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext.as_slice(),
                aad: EXPORT_AAD,
            },
        )
        .map_err(|_| "profile export encryption failed")?;
    key.zeroize();
    serde_json::to_string(&EncryptedProfileDocument {
        format: EXPORT_FORMAT.into(),
        version: EXPORT_VERSION,
        kdf: "argon2id-m19456-t2-p1".into(),
        salt: base64::engine::general_purpose::STANDARD_NO_PAD.encode(salt),
        nonce: base64::engine::general_purpose::STANDARD_NO_PAD.encode(nonce_bytes),
        ciphertext: base64::engine::general_purpose::STANDARD_NO_PAD.encode(ciphertext),
    })
    .map_err(|_| "host profiles could not be exported".into())
}

#[tauri::command]
pub fn mobile_import_host_profiles(
    app: AppHandle,
    request: ImportProfilesRequest,
) -> Result<ImportProfilesResult, String> {
    if request.document.len() > MAX_EXPORT_BYTES * 2 {
        return Err("host profile import is too large".into());
    }
    let document: EncryptedProfileDocument =
        serde_json::from_str(&request.document).map_err(|_| "host profile import is invalid")?;
    if document.format != EXPORT_FORMAT
        || document.version != EXPORT_VERSION
        || document.kdf != "argon2id-m19456-t2-p1"
    {
        return Err("host profile import format is unsupported".into());
    }
    let decode = |value: &str| {
        base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(value)
            .map_err(|_| "host profile import is invalid".to_string())
    };
    let salt = decode(&document.salt)?;
    let nonce = decode(&document.nonce)?;
    let ciphertext = decode(&document.ciphertext)?;
    if salt.len() != 16 || nonce.len() != 12 || ciphertext.len() > MAX_EXPORT_BYTES {
        return Err("host profile import is invalid".into());
    }
    let mut key = derive_export_key(&request.passphrase, &salt)?;
    let cipher =
        Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| "profile import decryption failed")?;
    let nonce: &Nonce<U12> = nonce
        .as_slice()
        .try_into()
        .map_err(|_| "host profile import is invalid")?;
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &ciphertext,
                    aad: EXPORT_AAD,
                },
            )
            .map_err(|_| "profile import passphrase or data is invalid")?,
    );
    key.zeroize();
    let imported: Vec<ExportProfile> = serde_json::from_slice(plaintext.as_slice())
        .map_err(|_| "host profile import is invalid")?;
    if imported.len() > MAX_PROFILES {
        return Err("too many host profiles in import".into());
    }
    let imported_ids: std::collections::HashSet<&str> =
        imported.iter().map(|profile| profile.id.as_str()).collect();
    if imported_ids.len() != imported.len()
        || imported.iter().any(|profile| {
            profile.jump.as_ref().is_some_and(|jump| {
                jump.host_profile_id == profile.id
                    || !imported_ids.contains(jump.host_profile_id.as_str())
            })
        })
    {
        return Err("host profile import references are invalid".into());
    }
    for profile in &imported {
        let request = SaveHostProfileRequest {
            id: Some(profile.id.clone()),
            name: profile.name.clone(),
            hostname: profile.hostname.clone(),
            port: profile.port,
            username: profile.username.clone(),
            preferred_transport: profile.preferred_transport.clone(),
            authentication: profile.authentication.clone(),
            credential_id: "cred_import_placeholder".into(),
            jump: profile.jump.clone(),
            mosh_udp_port_start: profile.mosh_udp_port_start,
            mosh_udp_port_end: profile.mosh_udp_port_end,
            enabled: profile.enabled,
            sort_order: profile.sort_order,
        };
        validate_request(&request)?;
    }
    let path = profile_path(&app)?;
    let mut profiles = read_profiles(&path)?;
    if profiles.len() + imported.len() > MAX_PROFILES {
        return Err("too many host profiles".into());
    }
    let next_order = profiles
        .iter()
        .map(|profile| profile.sort_order)
        .max()
        .unwrap_or(-1)
        .saturating_add(1);
    let id_map: HashMap<String, String> = imported
        .iter()
        .map(|profile| {
            (
                profile.id.clone(),
                format!("host_{}", uuid::Uuid::new_v4().simple()),
            )
        })
        .collect();
    let imported_count = imported.len();
    for (index, exported) in imported.into_iter().enumerate() {
        let id = id_map
            .get(&exported.id)
            .cloned()
            .ok_or_else(|| "host profile import is invalid".to_string())?;
        let jump = exported.jump.and_then(|jump| {
            id_map
                .get(&jump.host_profile_id)
                .cloned()
                .map(|host_profile_id| JumpProfile { host_profile_id })
        });
        profiles.push(HostProfile {
            id,
            name: exported.name,
            hostname: exported.hostname,
            port: exported.port,
            username: exported.username,
            preferred_transport: exported.preferred_transport,
            authentication: exported.authentication,
            credential_id: String::new(),
            jump,
            mosh_udp_port_start: exported.mosh_udp_port_start,
            mosh_udp_port_end: exported.mosh_udp_port_end,
            enabled: false,
            sort_order: next_order.saturating_add(index as i32),
            trusted_host_key: None,
            last_connected_at: None,
            last_error: Some("credential required after import".into()),
            last_known_summary: None,
        });
    }
    write_profiles(&path, &profiles)?;
    Ok(ImportProfilesResult { imported_count })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> SaveHostProfileRequest {
        SaveHostProfileRequest {
            id: None,
            name: "Work Mac".into(),
            hostname: "2001:db8::1".into(),
            port: 2222,
            username: "agent".into(),
            preferred_transport: PreferredTransport::Ssh,
            authentication: AuthenticationKind::PrivateKey,
            credential_id: "cred_shared".into(),
            jump: None,
            mosh_udp_port_start: Some(60000),
            mosh_udp_port_end: Some(61000),
            enabled: true,
            sort_order: 0,
        }
    }

    #[test]
    fn validates_ipv6_non_default_port_and_opaque_credential_reference() {
        assert!(validate_request(&request()).is_ok());
        let mut invalid = request();
        invalid.port = 0;
        assert!(validate_request(&invalid).is_err());
        let mut invalid = request();
        invalid.mosh_udp_port_end = Some(59999);
        assert!(validate_request(&invalid).is_err());
    }

    #[test]
    fn persisted_profile_shape_never_contains_credential_plaintext() {
        let fields = serde_json::to_value(HostProfile {
            id: "host_1".into(),
            name: "Work".into(),
            hostname: "example.test".into(),
            port: 22,
            username: "agent".into(),
            preferred_transport: PreferredTransport::Ssh,
            authentication: AuthenticationKind::Password,
            credential_id: "cred_1".into(),
            jump: None,
            mosh_udp_port_start: None,
            mosh_udp_port_end: None,
            enabled: true,
            sort_order: 0,
            trusted_host_key: None,
            last_connected_at: None,
            last_error: None,
            last_known_summary: None,
        })
        .unwrap();
        let object = fields.as_object().unwrap();
        assert!(object.contains_key("credentialId"));
        assert!(!object.contains_key("password") && !object.contains_key("privateKey"));
    }

    #[test]
    fn trust_identity_is_endpoint_scoped_and_normalized() {
        assert_eq!(
            trust_endpoint(" Example.TEST ", 2222),
            "[example.test]:2222"
        );
        assert_ne!(
            trust_endpoint("example.test", 22),
            trust_endpoint("example.test", 2222)
        );
        assert_ne!(
            trust_endpoint("2001:db8::1", 22),
            trust_endpoint("2001:db8::2", 22)
        );
    }

    #[test]
    fn encrypted_export_shape_excludes_credentials_and_trust() {
        let exported = ExportProfile {
            id: "host_1".into(),
            name: "Work".into(),
            hostname: "example.test".into(),
            port: 22,
            username: "agent".into(),
            preferred_transport: PreferredTransport::Ssh,
            authentication: AuthenticationKind::PrivateKey,
            jump: None,
            mosh_udp_port_start: None,
            mosh_udp_port_end: None,
            enabled: true,
            sort_order: 0,
        };
        let plaintext = serde_json::to_vec(&vec![exported]).unwrap();
        let mut key =
            derive_export_key("correct horse battery staple", b"0123456789abcdef").unwrap();
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).unwrap();
        let nonce = [7_u8; 12];
        let nonce_ref: &Nonce<U12> = nonce.as_slice().try_into().unwrap();
        let ciphertext = cipher
            .encrypt(
                nonce_ref,
                Payload {
                    msg: &plaintext,
                    aad: EXPORT_AAD,
                },
            )
            .unwrap();
        let decrypted = cipher
            .decrypt(
                nonce_ref,
                Payload {
                    msg: &ciphertext,
                    aad: EXPORT_AAD,
                },
            )
            .unwrap();
        key.zeroize();
        let text = String::from_utf8(decrypted).unwrap();
        assert!(!text.contains("credentialId"));
        assert!(!text.contains("trustedHostKey"));
        assert!(!text.contains("privateKey"));
        assert!(!text.contains("password"));
    }
}
