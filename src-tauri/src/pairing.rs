use agentport_pairing::{Invitation, PairedDevice, PairingServer, PairingStatus, SshTarget};
use serde::Serialize;
use std::{
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::Duration,
};
use tauri::State;

#[derive(Default)]
pub struct DesktopPairing(pub Mutex<Option<PairingServer>>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingDefaults {
    address: String,
    username: String,
}
fn local_username() -> Result<String, String> {
    let output = Command::new("/usr/bin/id")
        .arg("-un")
        .output()
        .map_err(|_| "Cannot identify local SSH account")?;
    if !output.status.success() {
        return Err("Cannot identify local SSH account".into());
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim().to_string())
        .map_err(|_| "Invalid local SSH account".into())
}
fn ssh_directory() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".ssh"))
        .ok_or("Home directory unavailable".into())
}
fn bridge_path() -> Result<PathBuf, String> {
    let path = std::env::current_exe()
        .map_err(|_| "Cannot locate AgentPort")?
        .parent()
        .ok_or("Cannot locate AgentPort")?
        .join("agentport-remote-bridge");
    if !path.is_file() {
        return Err("AgentPort Remote Bridge is missing from this app installation".into());
    }
    Ok(path)
}
#[tauri::command]
pub fn desktop_pairing_defaults() -> PairingDefaults {
    let address = ["en0", "en1"]
        .into_iter()
        .find_map(|interface| {
            Command::new("/usr/sbin/ipconfig")
                .args(["getifaddr", interface])
                .output()
                .ok()
                .filter(|result| result.status.success())
                .and_then(|result| String::from_utf8(result.stdout).ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_default();
    PairingDefaults {
        address,
        username: local_username().unwrap_or_default(),
    }
}
#[tauri::command]
pub fn desktop_pairing_start(
    state: State<'_, DesktopPairing>,
    address: String,
    username: String,
) -> Result<Invitation, String> {
    if username != local_username()? {
        return Err("Pairing can only authorize the current local SSH account".into());
    }
    bridge_path()?;
    // First-time pairing relies on the already-enabled macOS SSH service. It
    // never enables Remote Login, changes sshd configuration or requests root.
    TcpStream::connect_timeout(&SocketAddr::from(([127,0,0,1],22)), Duration::from_secs(2)).map_err(|_| "Enable macOS Remote Login and allow this user before pairing; AgentPort does not enable it automatically")?;
    let host_key = std::fs::read_to_string("/etc/ssh/ssh_host_ed25519_key.pub")
        .map_err(|_| "The system SSH host public key is unavailable")?;
    let key = host_key
        .split_whitespace()
        .take(2)
        .collect::<Vec<_>>()
        .join(" ");
    let fingerprint = agentport_pairing::public_key_fingerprint(&key)?;
    let target = SshTarget {
        name: "AgentPort".into(),
        hostname: address.clone(),
        port: 22,
        username,
        fingerprint,
    };
    let server = PairingServer::start(SocketAddr::from(([0, 0, 0, 0], 0)), address, target)?;
    let invitation = server.invitation().clone();
    *state.0.lock().map_err(|_| "Pairing state unavailable")? = Some(server);
    Ok(invitation)
}
#[tauri::command]
pub fn desktop_pairing_status(
    state: State<'_, DesktopPairing>,
) -> Result<Option<PairingStatus>, String> {
    state
        .0
        .lock()
        .map_err(|_| "Pairing state unavailable")?
        .as_ref()
        .map(PairingServer::status)
        .transpose()
}
#[tauri::command]
pub fn desktop_pairing_decide(
    state: State<'_, DesktopPairing>,
    invitation_id: String,
    request_id: String,
    approve: bool,
) -> Result<(), String> {
    let current = state.0.lock().map_err(|_| "Pairing state unavailable")?;
    let server = current.as_ref().ok_or("Pairing is no longer active")?;
    if server.invitation().id != invitation_id {
        return Err("Pairing code changed; review the current request".into());
    }
    server.decide(&request_id, approve, &ssh_directory()?, &bridge_path()?)
}
#[tauri::command]
pub fn desktop_pairing_close(
    state: State<'_, DesktopPairing>,
    invitation_id: String,
) -> Result<(), String> {
    let mut current = state.0.lock().map_err(|_| "Pairing state unavailable")?;
    if current
        .as_ref()
        .is_some_and(|server| server.invitation().id == invitation_id)
    {
        *current = None;
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_pairing_devices() -> Result<Vec<PairedDevice>, String> {
    agentport_pairing::devices(&ssh_directory()?)
}
#[tauri::command]
pub fn desktop_pairing_revoke(id: String, fingerprint: String) -> Result<(), String> {
    agentport_pairing::revoke(&ssh_directory()?, &id, &fingerprint)
}
