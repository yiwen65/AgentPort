//! Native-only Relay identity custody. JS gets opaque attempt/profile handles.
use crate::{
    credentials,
    hosts::{self, HostProfile},
};
use agentport_relay::{
    crypto::Identity,
    endpoint::{connect_session, PairingConnection},
    protocol::{now, validate_name, Invitation, Peer},
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, State};
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};

struct Attempt {
    profile: HostProfile,
    invitation: Invitation,
    device_name: String,
    started: bool,
    channel: Option<PairingConnection>,
    cancel: watch::Sender<bool>,
    _slot: OwnedSemaphorePermit,
}
#[derive(Clone)]
pub struct RelayPairings {
    attempts: Arc<Mutex<HashMap<String, Attempt>>>,
    slots: Arc<Semaphore>,
}
impl Default for RelayPairings {
    fn default() -> Self {
        Self {
            attempts: Arc::new(Mutex::new(HashMap::new())),
            slots: Arc::new(Semaphore::new(4)),
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    peer: Peer,
    expires_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    attempt_id: String,
    profile_id: String,
    peer: Peer,
    expires_at: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    request_id: String,
    verification_code: String,
}

#[tauri::command]
pub fn mobile_relay_pairing_preview(code: String) -> Result<Preview, String> {
    let invitation = Invitation::parse(&code).map_err(|e| e.to_string())?;
    Ok(Preview {
        peer: invitation.peer.clone(),
        expires_at: invitation.expires_at,
    })
}
#[tauri::command]
pub async fn mobile_relay_pairing_prepare(
    app: AppHandle,
    state: State<'_, RelayPairings>,
    code: String,
    device_name: String,
) -> Result<Prepared, String> {
    let invitation = Invitation::parse(&code).map_err(|e| e.to_string())?;
    validate_name(&device_name).map_err(|e| e.to_string())?;
    let slot = state
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Too many pending pairings")?;
    let peer = invitation.peer.clone();
    // Custody is durable BEFORE begin can send a candidate to the computer.
    let profile = tauri::async_runtime::spawn_blocking(move || {
        let identity = Identity::generate().map_err(|e| e.to_string())?;
        let credential = credentials::store_secret(&app, identity.private_bytes())?;
        // A failed save may already have committed: never delete this credential
        // on an unknown outcome or reuse any pre-existing SSH credential.
        hosts::create_relay_profile(&app, peer, identity.public_key(), credential)
    })
    .await
    .map_err(|_| "Pairing credential worker interrupted")??;
    let id = format!("pair_{}", uuid::Uuid::new_v4().simple());
    let result = Prepared {
        attempt_id: id.clone(),
        profile_id: profile.id.clone(),
        peer: invitation.peer.clone(),
        expires_at: invitation.expires_at,
    };
    let (cancel, _) = watch::channel(false);
    let ttl = invitation.expires_at.saturating_sub(now());
    state
        .attempts
        .lock()
        .map_err(|_| "Pairing state unavailable")?
        .insert(
            id.clone(),
            Attempt {
                profile,
                invitation,
                device_name,
                started: false,
                channel: None,
                cancel,
                _slot: slot,
            },
        );
    let attempts = state.attempts.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(ttl)).await;
        if let Ok(mut attempts) = attempts.lock() {
            if let Some(attempt) = attempts.remove(&id) {
                attempt.cancel.send_replace(true);
            }
        }
    });
    Ok(result)
}
#[tauri::command]
pub async fn mobile_relay_pairing_begin(
    app: AppHandle,
    state: State<'_, RelayPairings>,
    attempt_id: String,
) -> Result<Comparison, String> {
    let (profile, invitation, name, mut cancelled) = {
        let mut attempts = state
            .attempts
            .lock()
            .map_err(|_| "Pairing state unavailable")?;
        let attempt = attempts
            .get_mut(&attempt_id)
            .ok_or("Pairing cancelled or expired")?;
        if attempt.started {
            return Err(
                "Pairing exchange already started; refresh its status instead of replaying".into(),
            );
        }
        attempt.started = true;
        (
            attempt.profile.clone(),
            attempt.invitation.clone(),
            attempt.device_name.clone(),
            attempt.cancel.subscribe(),
        )
    };
    let key = credentials::load_credential(&app, &profile.credential_id)?;
    let identity = Identity::from_private(key).map_err(|e| e.to_string())?;
    if profile
        .relay
        .as_ref()
        .and_then(|r| r.device_public_key.as_deref())
        != Some(identity.public_key().as_str())
    {
        return Err("Pending Relay identity changed".into());
    }
    let channel = tokio::select! {
        value = PairingConnection::begin(&identity, &invitation, name) => value.map_err(|e| e.to_string())?,
        _ = cancelled.changed() => return Err("Pairing cancelled or expired; pending key retained".into()),
    };
    let result = Comparison {
        request_id: channel.request_id.clone(),
        verification_code: channel.verification_code.clone(),
    };
    let mut attempts = state
        .attempts
        .lock()
        .map_err(|_| "Pairing state unavailable")?;
    attempts
        .get_mut(&attempt_id)
        .ok_or("Pairing cancelled; pending key retained")?
        .channel = Some(channel);
    Ok(result)
}
#[tauri::command]
pub async fn mobile_relay_pairing_wait(
    app: AppHandle,
    state: State<'_, RelayPairings>,
    attempt_id: String,
) -> Result<HostProfile, String> {
    let (profile, channel, mut cancelled) = {
        let mut attempts = state
            .attempts
            .lock()
            .map_err(|_| "Pairing state unavailable")?;
        let attempt = attempts
            .get_mut(&attempt_id)
            .ok_or("Pairing cancelled or expired")?;
        (
            attempt.profile.clone(),
            attempt
                .channel
                .take()
                .ok_or("Pairing comparison is not ready")?,
            attempt.cancel.subscribe(),
        )
    };
    tokio::select! {
        result = channel.wait() => result.map_err(|e| e.to_string())?,
        _ = cancelled.changed() => return Err("Pairing cancelled or expired; pending key retained".into()),
    }
    let mut attempts = state
        .attempts
        .lock()
        .map_err(|_| "Pairing state unavailable")?;
    if !attempts.contains_key(&attempt_id) {
        return Err("Pairing cancelled; pending key retained".into());
    }
    // The encrypted approval binds request, computer AND exact phone identity.
    let result = hosts::approve_relay_profile(&app, &profile)?;
    attempts.remove(&attempt_id);
    Ok(result)
}
#[tauri::command]
pub fn mobile_relay_pairing_cancel(
    state: State<'_, RelayPairings>,
    attempt_id: String,
) -> Result<(), String> {
    if let Some(attempt) = state
        .attempts
        .lock()
        .map_err(|_| "Pairing state unavailable")?
        .remove(&attempt_id)
    {
        attempt.cancel.send_replace(true);
    }
    Ok(())
}
/// Explicit reconciliation after unknown approval: prove the retained key is
/// currently allowed by the pinned computer, never enable from a local boolean.
#[tauri::command]
pub async fn mobile_relay_pairing_reconcile(
    app: AppHandle,
    profile_id: String,
) -> Result<HostProfile, String> {
    let profile = hosts::get_profile(&app, &profile_id)?;
    let relay = profile.relay.as_ref().ok_or("Not a Relay profile")?;
    relay.validate()?;
    let identity =
        Identity::from_private(credentials::load_credential(&app, &profile.credential_id)?)
            .map_err(|e| e.to_string())?;
    if relay.device_public_key.as_deref() != Some(identity.public_key().as_str()) {
        return Err("Relay device identity changed; pair again".into());
    }
    let channel = connect_session(&identity, &relay.peer)
        .await
        .map_err(|e| e.to_string())?;
    drop(channel); // Authentication probe only; no Bridge command or Session input.
    hosts::approve_relay_profile(&app, &profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_exposes_only_pinned_public_metadata_and_rejects_expired_or_ssh_codes() {
        let computer = Identity::generate().unwrap();
        let mut invitation = Invitation::new(
            computer
                .peer("ws://127.0.0.1/v1/relay".into(), "Fixture".into())
                .unwrap(),
        )
        .unwrap();
        let preview =
            mobile_relay_pairing_preview(serde_json::to_string(&invitation).unwrap()).unwrap();
        let serialized = serde_json::to_string(&preview).unwrap();
        assert!(!serialized.contains(&invitation.secret));
        assert_eq!(preview.peer.public_key, computer.public_key());
        invitation.expires_at = now();
        assert!(mobile_relay_pairing_preview(serde_json::to_string(&invitation).unwrap()).is_err());
        assert!(
            mobile_relay_pairing_preview(r#"{"ssh":{"hostname":"local","port":22}}"#.into())
                .is_err()
        );
    }
}
