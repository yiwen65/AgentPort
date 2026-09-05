use agentport_pairing::{Invitation, PairingReply, PairingRequest, SshTarget};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingPreview {
    ssh: SshTarget,
    expires_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPairing {
    request: PairingRequest,
    verification_code: String,
}

#[tauri::command]
pub fn mobile_pairing_preview(code: String) -> Result<PairingPreview, String> {
    let invitation = Invitation::parse(&code)?;
    Ok(PairingPreview {
        ssh: invitation.ssh.clone(),
        expires_at: invitation.expires_at,
    })
}
#[tauri::command]
pub fn mobile_pairing_prepare(
    code: String,
    public_key: String,
    device_name: String,
) -> Result<PreparedPairing, String> {
    let invitation = Invitation::parse(&code)?;
    let request = PairingRequest {
        request_id: agentport_pairing::random_id()?,
        device_name,
        public_key,
    };
    request.validate()?;
    Ok(PreparedPairing {
        verification_code: request.verification_code(&invitation),
        request,
    })
}
#[tauri::command]
pub async fn mobile_pairing_exchange(
    code: String,
    request: PairingRequest,
) -> Result<PairingReply, String> {
    let invitation = Invitation::parse(&code)?;
    tauri::async_runtime::spawn_blocking(move || agentport_pairing::exchange(&invitation, &request))
        .await
        .map_err(|_| "Pairing worker interrupted".to_string())?
}
