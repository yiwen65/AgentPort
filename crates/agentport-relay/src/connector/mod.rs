//! Independent desktop authorization/Bridge owner. GUI uses protected local IPC.
pub mod apns;
pub mod ipc;
pub mod push_worker;
mod storage;
use crate::{
    crypto::{Handshake, Identity},
    endpoint::{PairHello, PairReply, PushEnvironment, PushRegistration, PushRegistrationReply},
    net::{self, SecureChannel, Socket},
    protocol::*,
    Error, Result,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
pub use storage::{private_directory, Store};
use tokio::{
    sync::{watch, Mutex, Semaphore},
    task::{JoinHandle, JoinSet},
};
use tokio_tungstenite::tungstenite::Message;
use zeroize::Zeroizing;
const MAX_DEVICES: usize = 64;
const MAX_CHANNELS: usize = 32;

pub trait Vault: Send + Sync {
    fn load(&self, account: &str) -> Result<Zeroizing<Vec<u8>>>;
    fn create(&self, secret: &[u8]) -> Result<String>;
}
pub struct Keychain;
impl Vault for Keychain {
    fn load(&self, account: &str) -> Result<Zeroizing<Vec<u8>>> {
        decode::<16>(account).map_err(|_| Error::Credential)?;
        keyring::Entry::new("com.agentport.relay.connector.v1", account)
            .map_err(|_| Error::Credential)?
            .get_secret()
            .map(Zeroizing::new)
            .map_err(|_| Error::Credential)
    }
    fn create(&self, secret: &[u8]) -> Result<String> {
        let account = identifier()?;
        let entry = keyring::Entry::new("com.agentport.relay.connector.v1", &account)
            .map_err(|_| Error::Credential)?;
        // Random new account, never overwrite an existing or manual SSH credential.
        match entry.get_secret() {
            Err(keyring::Error::NoEntry) => {}
            _ => return Err(Error::Credential),
        }
        entry.set_secret(secret).map_err(|_| Error::Credential)?;
        if self.load(&account)?.as_slice() != secret {
            return Err(Error::Credential);
        }
        Ok(account)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Device {
    pub public_key: String,
    pub name: String,
    pub approved_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<PushRegistration>,
    /// Connector-owned baseline for first delivery; repeated registration of
    /// the same token never resets it or skips intervening messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push_registered_at_ms: Option<i64>,
}
/// A point-in-time snapshot of authorized targets; recheck before each send.
#[derive(Clone, Debug)]
pub struct PushTarget {
    pub public_key: String,
    pub registration: PushRegistration,
    pub registered_at_ms: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    peer: Peer,
    identity_account: String,
    token_account: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Persistent {
    version: u8,
    settings: Option<Settings>,
    devices: Vec<Device>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    apns: Option<ApnsSettings>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApnsSettings {
    key_account: String,
    key_id: String,
    team_id: String,
    topic: String,
    environment: PushEnvironment,
}
/// Key material is loaded only from the Keychain and never serialized into state or status.
pub struct ApnsCredentials {
    pub key_p8_pem: Zeroizing<Vec<u8>>,
    pub key_id: String,
    pub team_id: String,
    pub topic: String,
    pub environment: PushEnvironment,
}
impl Default for Persistent {
    fn default() -> Self {
        Self {
            version: VERSION,
            settings: None,
            devices: Vec::new(),
            apns: None,
        }
    }
}
impl Persistent {
    fn validate(&self) -> Result<()> {
        if self.version != VERSION
            || self.devices.len() > MAX_DEVICES
            || (self.settings.is_none() && !self.devices.is_empty())
        {
            return Err(Error::Storage);
        }
        if let Some(settings) = &self.settings {
            settings.peer.validate()?;
            decode::<16>(&settings.identity_account)?;
            decode::<16>(&settings.token_account)?;
        }
        if let Some(apns) = &self.apns {
            decode::<16>(&apns.key_account).map_err(|_| Error::Storage)?;
            if !valid_apns_metadata(&apns.key_id, &apns.team_id, &apns.topic) {
                return Err(Error::Storage);
            }
        }
        let mut seen = std::collections::HashSet::new();
        for device in &self.devices {
            validate_name(&device.name)?;
            if decode::<32>(&device.public_key)? == [0; 32] || !seen.insert(&device.public_key) {
                return Err(Error::Storage);
            }
            if let Some(push) = &device.push {
                push.validate().map_err(|_| Error::Storage)?;
            }
        }
        Ok(())
    }
}
struct Configured {
    identity: Identity,
    token: Zeroizing<String>,
    peer: Peer,
}
fn load_settings(settings: &Settings, vault: &dyn Vault) -> Result<Configured> {
    let identity = Identity::from_private(vault.load(&settings.identity_account)?)?;
    if identity.public_key() != settings.peer.public_key {
        return Err(Error::Credential);
    }
    let token = Zeroizing::new(
        String::from_utf8(vault.load(&settings.token_account)?.to_vec())
            .map_err(|_| Error::Credential)?,
    );
    validate_token(&token)?;
    Ok(Configured {
        identity,
        token,
        peer: settings.peer.clone(),
    })
}
fn apns_environment(environment: PushEnvironment) -> apns::Environment {
    match environment {
        PushEnvironment::Sandbox => apns::Environment::Sandbox,
        PushEnvironment::Production => apns::Environment::Production,
    }
}
fn valid_apns_metadata(key_id: &str, team_id: &str, topic: &str) -> bool {
    let apple_id = |value: &str| {
        value.len() == 10
            && value
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    };
    let topic_part = |part: &str| {
        !part.is_empty()
            && part.len() <= 63
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    apple_id(key_id)
        && apple_id(team_id)
        && (3..=255).contains(&topic.len())
        && topic.contains('.')
        && topic.split('.').all(topic_part)
}
fn load_apns(settings: &ApnsSettings, vault: &dyn Vault) -> Result<ApnsCredentials> {
    let pem = vault.load(&settings.key_account)?;
    if pem.is_empty()
        || pem.len() > 8192
        || apns::ApnsSender::new(
            &pem,
            &settings.key_id,
            &settings.team_id,
            &settings.topic,
            apns_environment(settings.environment),
        )
        .is_err()
    {
        return Err(Error::Credential);
    }
    Ok(ApnsCredentials {
        key_p8_pem: pem,
        key_id: settings.key_id.clone(),
        team_id: settings.team_id.clone(),
        topic: settings.topic.clone(),
        environment: settings.environment,
    })
}
fn validate_token(token: &str) -> Result<()> {
    if !(16..=256).contains(&token.len()) {
        return Err(Error::Invalid("registration token length"));
    }
    Ok(())
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Unconfigured,
    Connecting,
    Connected,
    Reconnecting,
    AuthenticationFailed,
    StorageFailed,
    Stopped,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub request_id: String,
    pub public_key: String,
    pub name: String,
    pub verification_code: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PairPhase {
    Waiting,
    Pending,
    Approved,
    Denied,
    Expired,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairStatus {
    pub invitation_id: String,
    pub expires_at: u64,
    pub phase: PairPhase,
    pub candidate: Option<Candidate>,
}
struct Pairing {
    automatic: bool,
    invitation: Invitation,
    status: PairStatus,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    pub version: u8,
    pub phase: Phase,
    pub peer: Option<Peer>,
    pub devices: Vec<Device>,
    pub pairing: Option<PairStatus>,
    pub active_channels: usize,
    pub apns_configured: bool,
    #[serde(default)]
    pub apns_delivery_active: bool,
}
struct Inner {
    durable: Persistent,
    configured: Option<Arc<Configured>>,
    apns_available: bool,
    apns_delivery_active: bool,
    phase: Phase,
    pairing: Option<Pairing>,
    channels: HashMap<String, Vec<JoinHandle<Result<()>>>>,
    stopping: bool,
}
pub struct Runtime {
    inner: Mutex<Inner>,
    store: Arc<Store>,
    vault: Arc<dyn Vault>,
    bridge: PathBuf,
    data_dir: PathBuf,
    host_socket_dir: Option<PathBuf>,
    changed: watch::Sender<u64>,
    shutdown: watch::Sender<bool>,
}
impl Runtime {
    pub async fn open(
        store: Store,
        vault: Arc<dyn Vault>,
        bridge: PathBuf,
        data_dir: PathBuf,
        host_socket_dir: Option<PathBuf>,
    ) -> Result<Arc<Self>> {
        if !bridge.is_absolute() || !bridge.is_file() || !data_dir.is_absolute() {
            return Err(Error::Invalid("connector Bridge/data path"));
        }
        let durable: Persistent = store.read()?.unwrap_or_default();
        durable.validate()?;
        let settings = durable.settings.clone();
        let loader = vault.clone();
        let loaded = tokio::task::spawn_blocking(move || {
            settings
                .as_ref()
                .map(|s| load_settings(s, loader.as_ref()))
                .transpose()
        })
        .await
        .map_err(|_| Error::Credential)?;
        let apns_settings = durable.apns.clone();
        let apns_vault = vault.clone();
        let apns_available = tokio::task::spawn_blocking(move || {
            apns_settings
                .as_ref()
                .is_some_and(|s| load_apns(s, apns_vault.as_ref()).is_ok())
        })
        .await
        .map_err(|_| Error::Credential)?;
        let (configured, phase) = match loaded {
            Ok(Some(configured)) => (Some(Arc::new(configured)), Phase::Connecting),
            Ok(None) => (None, Phase::Unconfigured),
            Err(_) => (None, Phase::AuthenticationFailed),
        };
        let (changed, _) = watch::channel(0);
        let (shutdown, _) = watch::channel(false);
        Ok(Arc::new(Self {
            inner: Mutex::new(Inner {
                durable,
                configured,
                apns_available,
                apns_delivery_active: false,
                phase,
                pairing: None,
                channels: HashMap::new(),
                stopping: false,
            }),
            store: Arc::new(store),
            vault,
            bridge,
            data_dir,
            host_socket_dir,
            changed,
            shutdown,
        }))
    }
    pub async fn status(&self) -> Status {
        let mut inner = self.inner.lock().await;
        reap(&mut inner);
        if let Some(pairing) = &mut inner.pairing {
            if pairing.invitation.expires_at <= now()
                && matches!(
                    pairing.status.phase,
                    PairPhase::Waiting | PairPhase::Pending
                )
            {
                pairing.status.phase = PairPhase::Expired;
            }
        }
        Status {
            version: VERSION,
            phase: inner.phase.clone(),
            peer: inner.durable.settings.as_ref().map(|s| s.peer.clone()),
            devices: inner
                .durable
                .devices
                .iter()
                .cloned()
                .map(|mut device| {
                    device.push = None; // Local IPC status must not disclose APNs tokens.
                    device.push_registered_at_ms = None;
                    device
                })
                .collect(),
            pairing: inner.pairing.as_ref().map(|p| p.status.clone()),
            active_channels: inner.channels.values().map(Vec::len).sum(),
            apns_configured: inner.apns_available,
            apns_delivery_active: inner.apns_delivery_active,
        }
    }
    /// Reflect actual worker liveness in same-user IPC; credentials alone do
    /// not mean pushes are being attempted.
    pub async fn set_apns_delivery_active(&self, active: bool) {
        self.inner.lock().await.apns_delivery_active = active;
    }
    /// Import the APNs signing key into the same-user Keychain, then persist
    /// only the new account identifier and nonsecret metadata atomically.
    pub async fn configure_apns(
        &self,
        key_p8_pem: Zeroizing<String>,
        key_id: String,
        team_id: String,
        topic: String,
        environment: PushEnvironment,
    ) -> Result<()> {
        if key_p8_pem.is_empty()
            || key_p8_pem.len() > 8192
            || !valid_apns_metadata(&key_id, &team_id, &topic)
        {
            return Err(Error::Invalid("APNs configuration"));
        }
        let mut inner = self.inner.lock().await;
        if inner.stopping || inner.phase == Phase::StorageFailed {
            return Err(Error::Storage);
        }
        let vault = self.vault.clone();
        let settings = tokio::task::spawn_blocking(move || {
            apns::ApnsSender::new(
                key_p8_pem.as_bytes(),
                &key_id,
                &team_id,
                &topic,
                apns_environment(environment),
            )
            .map_err(|_| Error::Invalid("APNs configuration"))?;
            let key_account = vault.create(key_p8_pem.as_bytes())?;
            let settings = ApnsSettings {
                key_account,
                key_id,
                team_id,
                topic,
                environment,
            };
            load_apns(&settings, vault.as_ref())?;
            Ok::<_, Error>(settings)
        })
        .await
        .map_err(|_| Error::Credential)??;
        let mut next = inner.durable.clone();
        next.apns = Some(settings);
        if self.store.write(&next).is_err() {
            inner.apns_available = false;
            inner.phase = Phase::StorageFailed;
            inner.configured = None;
            self.changed.send_modify(|n| *n += 1);
            return Err(Error::Storage);
        }
        inner.durable = next;
        inner.apns_available = true;
        Ok(())
    }
    /// An absent or unavailable Keychain account never produces signing material.
    pub async fn apns_credentials(&self) -> Result<Option<ApnsCredentials>> {
        let inner = self.inner.lock().await;
        if inner.stopping || inner.phase == Phase::StorageFailed {
            return Ok(None);
        }
        let Some(settings) = inner.durable.apns.clone() else {
            return Ok(None);
        };
        if !inner.apns_available {
            return Err(Error::Credential);
        }
        let vault = self.vault.clone();
        drop(inner);
        tokio::task::spawn_blocking(move || load_apns(&settings, vault.as_ref()))
            .await
            .map_err(|_| Error::Credential)?
            .map(Some)
    }
    pub async fn configure(
        &self,
        relay_url: String,
        name: String,
        token: Zeroizing<String>,
    ) -> Result<()> {
        validate_url(&relay_url)?;
        validate_name(&name)?;
        validate_token(&token)?;
        let mut inner = self.inner.lock().await;
        if inner.stopping || inner.phase == Phase::StorageFailed {
            return Err(Error::Storage);
        }
        let old = inner.durable.settings.clone();
        let vault = self.vault.clone();
        // Existing identity is loaded, never silently regenerated on keychain failure.
        let (settings, configured) = tokio::task::spawn_blocking(move || {
            let (identity, identity_account) = if let Some(old) = old {
                let identity = Identity::from_private(vault.load(&old.identity_account)?)?;
                if identity.public_key() != old.peer.public_key {
                    return Err(Error::Credential);
                }
                (identity, old.identity_account)
            } else {
                let identity = Identity::generate()?;
                let account = vault.create(identity.private_bytes())?;
                (identity, account)
            };
            let token_account = vault.create(token.as_bytes())?;
            let peer = identity.peer(relay_url, name)?;
            Ok((
                Settings {
                    peer: peer.clone(),
                    identity_account,
                    token_account,
                },
                Configured {
                    identity,
                    token,
                    peer,
                },
            ))
        })
        .await
        .map_err(|_| Error::Credential)??;
        let mut next = inner.durable.clone();
        next.settings = Some(settings);
        if self.store.write(&next).is_err() {
            inner.phase = Phase::StorageFailed;
            inner.configured = None;
            self.changed.send_modify(|n| *n += 1);
            return Err(Error::Storage);
        }
        inner.durable = next;
        inner.configured = Some(Arc::new(configured));
        inner.pairing = None;
        inner.phase = Phase::Connecting;
        let channels = std::mem::take(&mut inner.channels);
        // Publish while locked so an old registration can never publish newer status.
        self.changed.send_modify(|n| *n += 1);
        drop(inner);
        close_channels(channels.into_values().flatten().collect()).await;
        Ok(())
    }
    pub async fn invite(&self) -> Result<Invitation> {
        self.invite_with_approval(false).await
    }
    /// Creating this short-lived QR explicitly grants its first authenticated
    /// holder access; the registration token is never part of the invitation.
    pub async fn invite_automatic(&self) -> Result<Invitation> {
        self.invite_with_approval(true).await
    }
    async fn invite_with_approval(&self, automatic: bool) -> Result<Invitation> {
        let mut inner = self.inner.lock().await;
        if inner.stopping || inner.phase != Phase::Connected {
            return Err(Error::Offline);
        }
        let configured = inner.configured.as_ref().ok_or(Error::Offline)?;
        let invitation = Invitation::new(configured.peer.clone())?;
        inner.pairing = Some(Pairing {
            automatic,
            status: PairStatus {
                invitation_id: invitation.id.clone(),
                expires_at: invitation.expires_at,
                phase: PairPhase::Waiting,
                candidate: None,
            },
            invitation: invitation.clone(),
        });
        Ok(invitation)
    }
    pub async fn close_invitation(&self, id: &str) {
        let mut inner = self.inner.lock().await;
        if inner
            .pairing
            .as_ref()
            .is_some_and(|p| p.invitation.id == id)
        {
            inner.pairing = None;
        }
    }
    pub async fn decide(
        &self,
        invitation_id: &str,
        request_id: &str,
        public_key: &str,
        approve: bool,
    ) -> Result<()> {
        let mut inner = self.inner.lock().await;
        if inner.stopping || inner.phase == Phase::StorageFailed {
            return Err(Error::Storage);
        }
        let pairing = inner.pairing.as_ref().ok_or(Error::Unauthorized)?;
        let candidate = pairing
            .status
            .candidate
            .as_ref()
            .ok_or(Error::Unauthorized)?
            .clone();
        if pairing.invitation.id != invitation_id
            || pairing.invitation.expires_at <= now()
            || pairing.status.phase != PairPhase::Pending
            || candidate.request_id != request_id
            || candidate.public_key != public_key
        {
            return Err(Error::Unauthorized);
        }
        if approve {
            let mut next = inner.durable.clone();
            next.devices.retain(|d| d.public_key != public_key);
            if next.devices.len() >= MAX_DEVICES {
                return Err(Error::Busy);
            }
            next.devices.push(Device {
                public_key: candidate.public_key,
                name: candidate.name,
                approved_at: now(),
                push: None,
                push_registered_at_ms: None,
            });
            if self.store.write(&next).is_err() {
                inner.phase = Phase::StorageFailed;
                inner.configured = None;
                self.changed.send_modify(|n| *n += 1);
                return Err(Error::Storage);
            }
            inner.durable = next;
        }
        inner
            .pairing
            .as_mut()
            .ok_or(Error::Unauthorized)?
            .status
            .phase = if approve {
            PairPhase::Approved
        } else {
            PairPhase::Denied
        };
        Ok(())
    }
    /// Snapshot only approved devices with a valid registered token. Never use
    /// this as authorization after revocation; check immediately before delivery.
    pub async fn push_targets(&self) -> Vec<PushTarget> {
        let inner = self.inner.lock().await;
        if inner.stopping || inner.phase == Phase::StorageFailed || inner.configured.is_none() {
            return Vec::new();
        }
        inner
            .durable
            .devices
            .iter()
            .filter_map(|device| {
                device.push.clone().map(|registration| PushTarget {
                    public_key: device.public_key.clone(),
                    registration,
                    registered_at_ms: device.push_registered_at_ms,
                })
            })
            .collect()
    }
    pub async fn is_push_target_authorized(&self, target: &PushTarget) -> bool {
        let inner = self.inner.lock().await;
        !inner.stopping
            && inner.phase != Phase::StorageFailed
            && inner.configured.is_some()
            && inner.durable.devices.iter().any(|device| {
                device.public_key == target.public_key
                    && device.push.as_ref() == Some(&target.registration)
            })
    }
    pub async fn revoke(&self, public_key: &str) -> Result<()> {
        decode::<32>(public_key)?;
        let mut inner = self.inner.lock().await;
        let mut next = inner.durable.clone();
        next.devices.retain(|d| d.public_key != public_key);
        let result = self.store.write(&next);
        // Even a failed/uncertain disk write must not keep serving revoked access.
        inner.durable = next;
        if result.is_err() {
            inner.phase = Phase::StorageFailed;
            inner.configured = None;
            self.changed.send_modify(|n| *n += 1);
        }
        if let Some(pairing) = &mut inner.pairing {
            if pairing
                .status
                .candidate
                .as_ref()
                .is_some_and(|c| c.public_key == public_key)
            {
                pairing.status.phase = PairPhase::Denied;
            }
        }
        let channels = inner.channels.remove(public_key).unwrap_or_default();
        drop(inner);
        close_channels(channels).await;
        result.map_err(|_| Error::Storage)
    }
    /// Explicit recovery from lost credentials: abandons the durable
    /// configuration, identity anchor, and every device grant. A fresh
    /// identity is created only by a later explicit configure, never here.
    pub async fn reset(&self) -> Result<()> {
        let mut inner = self.inner.lock().await;
        if inner.stopping || inner.phase == Phase::StorageFailed {
            return Err(Error::Storage);
        }
        let mut next = inner.durable.clone();
        // Devices are anchored to the same identity as the settings and are
        // invalid without them (validate forbids devices without settings).
        next.settings = None;
        next.devices = Vec::new();
        if self.store.write(&next).is_err() {
            inner.phase = Phase::StorageFailed;
            inner.configured = None;
            self.changed.send_modify(|n| *n += 1);
            return Err(Error::Storage);
        }
        inner.durable = next;
        inner.configured = None;
        inner.pairing = None;
        inner.phase = Phase::Unconfigured;
        let channels = std::mem::take(&mut inner.channels);
        self.changed.send_modify(|n| *n += 1);
        drop(inner);
        close_channels(channels.into_values().flatten().collect()).await;
        Ok(())
    }
    pub async fn stop(&self) {
        let mut inner = self.inner.lock().await;
        inner.stopping = true;
        inner.phase = Phase::Stopped;
        inner.pairing = None;
        inner.configured = None;
        self.shutdown.send_replace(true);
        self.changed.send_modify(|n| *n += 1);
        let channels = std::mem::take(&mut inner.channels);
        drop(inner);
        close_channels(channels.into_values().flatten().collect()).await;
    }
    pub fn shutdown_signal(&self) -> watch::Receiver<bool> {
        self.shutdown.subscribe()
    }
    pub async fn run(self: Arc<Self>) {
        let mut changes = self.changed.subscribe();
        let mut stopped = self.shutdown.subscribe();
        let slots = Arc::new(Semaphore::new(MAX_CHANNELS));
        let mut attempts = 0u32;
        loop {
            if *stopped.borrow() {
                break;
            }
            let generation = *changes.borrow_and_update();
            let configured = self.inner.lock().await.configured.clone();
            let Some(configured) = configured else {
                tokio::select! { _ = changes.changed() => {}, _ = stopped.changed() => break }
                attempts = 0;
                continue;
            };
            let result = tokio::select! {
                result = self.registration(configured, generation, slots.clone()) => Some(result),
                _ = changes.changed() => None,
                _ = stopped.changed() => break,
            };
            let Some(result) = result else {
                attempts = 0;
                continue;
            };
            let unauthorized = matches!(result, Err(Error::Unauthorized));
            {
                let mut inner = self.inner.lock().await;
                if *changes.borrow() != generation || inner.stopping {
                    continue;
                }
                inner.phase = if unauthorized {
                    Phase::AuthenticationFailed
                } else {
                    Phase::Reconnecting
                };
            }
            if unauthorized {
                tokio::select! { _ = changes.changed() => {}, _ = stopped.changed() => break }
                attempts = 0;
            } else {
                let delay = Duration::from_secs(1u64 << attempts.min(5));
                attempts = attempts.saturating_add(1);
                tokio::select! { _ = tokio::time::sleep(delay) => {}, _ = changes.changed() => { attempts = 0; }, _ = stopped.changed() => break }
            }
        }
    }
    async fn registration(
        self: &Arc<Self>,
        configured: Arc<Configured>,
        generation: u64,
        slots: Arc<Semaphore>,
    ) -> Result<()> {
        let mut socket = net::register_host(
            &configured.peer.relay_url,
            &configured.identity,
            &configured.token,
        )
        .await?;
        {
            let mut inner = self.inner.lock().await;
            if *self.changed.borrow() != generation || inner.stopping {
                return Err(Error::Offline);
            }
            inner.phase = Phase::Connected;
        }
        let mut tasks = JoinSet::new();
        let mut heartbeat = tokio::time::interval(net::HEARTBEAT);
        let mut received = tokio::time::Instant::now();
        loop {
            tokio::select! {
                message = socket.next() => {
                    received = tokio::time::Instant::now();
                    match message.ok_or(Error::Transport)?? {
                        Message::Binary(bytes) if bytes.len() <= MAX_CONTROL => {
                            let Control::Incoming { connection_id, mode } = serde_json::from_slice(&bytes)? else { return Err(Error::Protocol); };
                            decode::<16>(&connection_id)?; mode.context(&configured.peer.host_id)?;
                            let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                            let runtime = self.clone(); let configured = configured.clone();
                            tasks.spawn(async move { let _ = runtime.incoming(configured, generation, connection_id, mode, slot).await; });
                        },
                        Message::Ping(_) => net::timed(async { socket.flush().await?; Ok(()) }).await?,
                        Message::Pong(_) => {},
                        _ => return Err(Error::Transport),
                    }
                },
                _ = tasks.join_next(), if !tasks.is_empty() => {},
                _ = heartbeat.tick() => {
                    if received.elapsed() > net::IDLE_TIMEOUT { return Err(Error::Timeout); }
                    net::timed(async { socket.send(Message::Ping(Vec::new().into())).await?; Ok(()) }).await?;
                }
            }
        }
    }
    async fn incoming(
        self: Arc<Self>,
        configured: Arc<Configured>,
        generation: u64,
        connection_id: String,
        mode: Mode,
        slot: tokio::sync::OwnedSemaphorePermit,
    ) -> Result<()> {
        match mode {
            Mode::Pair { invitation_id } => {
                let invitation = {
                    let inner = self.inner.lock().await;
                    let pairing = inner.pairing.as_ref().ok_or(Error::Unauthorized)?;
                    if *self.changed.borrow() != generation
                        || pairing.invitation.id != invitation_id
                        || pairing.status.phase != PairPhase::Waiting
                    {
                        return Err(Error::Unauthorized);
                    }
                    pairing.invitation.validate()?;
                    pairing.invitation.clone()
                };
                let socket = net::accept_connection(
                    &configured.peer.relay_url,
                    &configured.identity,
                    &connection_id,
                )
                .await?;
                let deadline = Duration::from_secs(invitation.expires_at.saturating_sub(now()));
                tokio::time::timeout(
                    deadline,
                    self.pair(configured, generation, socket, invitation),
                )
                .await
                .map_err(|_| Error::Timeout)?
            }
            Mode::Session => {
                let mut socket = net::accept_connection(
                    &configured.peer.relay_url,
                    &configured.identity,
                    &connection_id,
                )
                .await?;
                let mut noise = Handshake::session(&configured.identity, &configured.peer, false)?;
                let offer = noise.read(&net::receive_packet(&mut socket).await?)?;
                let realtime = offer.as_slice() == crate::endpoint::WSS_STREAM_OFFER;
                let push_registration = offer.as_slice() == crate::endpoint::PUSH_REGISTER_OFFER;
                if !offer.is_empty() && !realtime && !push_registration {
                    return Err(Error::Protocol);
                }
                let key = encode(&noise.remote_key()?);
                let mut inner = self.inner.lock().await;
                reap(&mut inner);
                if inner.stopping
                    || *self.changed.borrow() != generation
                    || inner.phase == Phase::StorageFailed
                    || !inner.durable.devices.iter().any(|d| d.public_key == key)
                {
                    drop(inner);
                    // Authenticated negative reply lets Mobile stop retries without trusting Relay errors.
                    net::send_packet(&mut socket, noise.write(b"denied")?).await?;
                    return Err(Error::Unauthorized);
                }
                if inner
                    .channels
                    .get(&key)
                    .is_some_and(|channels| channels.len() >= 8)
                {
                    return Err(Error::Busy);
                }
                let runtime = self.clone();
                // Authorization and ownership registration share the revocation lock.
                // Revoke aborts AND joins this task, dropping socket/Bridge before ack.
                inner
                    .channels
                    .entry(key.clone())
                    .or_default()
                    .push(tokio::spawn(async move {
                        let _slot = slot;
                        let response = if push_registration {
                            crate::endpoint::PUSH_REGISTER_ACCEPTED
                        } else if realtime {
                            crate::endpoint::WSS_STREAM_ACCEPTED
                        } else {
                            b"accepted"
                        };
                        net::send_packet(&mut socket, noise.write(response)?).await?;
                        let established = noise.finish()?;
                        if push_registration {
                            runtime
                                .register_push(SecureChannel::new(socket, established), &key)
                                .await
                        } else {
                            let stream = if realtime {
                                net::EncryptedStream::authenticated_wss(socket)
                            } else {
                                SecureChannel::new(socket, established).into_stream()
                            };
                            runtime.bridge(stream).await
                        }
                    }));
                Ok(())
            }
        }
    }
    async fn register_push(&self, mut channel: SecureChannel, public_key: &str) -> Result<()> {
        let registration: PushRegistration = channel.receive().await?;
        if registration.validate().is_err() {
            channel.send(&PushRegistrationReply::Rejected).await?;
            return Err(Error::Invalid("APNs registration"));
        }
        let mut inner = self.inner.lock().await;
        if inner.stopping || inner.phase == Phase::StorageFailed || inner.configured.is_none() {
            return Err(Error::Unauthorized);
        }
        let mut next = inner.durable.clone();
        let device = next
            .devices
            .iter_mut()
            .find(|d| d.public_key == public_key)
            .ok_or(Error::Unauthorized)?;
        if device.push.as_ref() != Some(&registration) || device.push_registered_at_ms.is_none() {
            device.push_registered_at_ms = Some(chrono::Utc::now().timestamp_millis());
        }
        device.push = Some(registration);
        // Keep authorization lock across the atomic write. Revoke cannot race
        // registration's success acknowledgement or leave an orphaned token.
        if self.store.write(&next).is_err() {
            inner.phase = Phase::StorageFailed;
            inner.configured = None;
            self.changed.send_modify(|n| *n += 1);
            return Err(Error::Storage);
        }
        inner.durable = next;
        drop(inner);
        channel.send(&PushRegistrationReply::Registered).await
    }
    async fn pair(
        &self,
        configured: Arc<Configured>,
        generation: u64,
        mut socket: Socket,
        invitation: Invitation,
    ) -> Result<()> {
        let mut noise = Handshake::pair(&configured.identity, &invitation, false)?;
        noise.read(&net::receive_packet(&mut socket).await?)?;
        net::send_packet(&mut socket, noise.write(&[])?).await?;
        let hello: PairHello =
            serde_json::from_slice(&noise.read(&net::receive_packet(&mut socket).await?)?)?;
        validate_name(&hello.name)?;
        let established = noise.finish()?;
        let candidate = Candidate {
            request_id: identifier()?,
            public_key: established.remote_key.clone().ok_or(Error::Unauthorized)?,
            name: hello.name,
            verification_code: established.verification_code.clone(),
        };
        let automatic = {
            let mut inner = self.inner.lock().await;
            if inner.stopping || *self.changed.borrow() != generation {
                return Err(Error::Unauthorized);
            }
            let pairing = inner.pairing.as_mut().ok_or(Error::Unauthorized)?;
            if pairing.invitation.id != invitation.id
                || invitation.expires_at <= now()
                || pairing.status.phase != PairPhase::Waiting
            {
                return Err(Error::Unauthorized);
            }
            // Only a fully authenticated candidate can claim the one-time invite.
            pairing.status.phase = PairPhase::Pending;
            pairing.status.candidate = Some(candidate.clone());
            pairing.automatic
        };
        if automatic {
            // Reuse the exact identity/expiry checks and durable allowlist
            // transaction. No success is sent if persistence fails.
            self.decide(
                &invitation.id,
                &candidate.request_id,
                &candidate.public_key,
                true,
            )
            .await?;
        }
        let mut channel = SecureChannel::new(socket, established);
        channel
            .send(&PairReply::Pending {
                request_id: candidate.request_id.clone(),
            })
            .await?;
        loop {
            let phase = {
                let inner = self.inner.lock().await;
                if *self.changed.borrow() != generation || inner.stopping {
                    PairPhase::Denied
                } else {
                    inner
                        .pairing
                        .as_ref()
                        .filter(|p| p.invitation.id == invitation.id)
                        .map(|p| p.status.phase.clone())
                        .unwrap_or(PairPhase::Denied)
                }
            };
            match phase {
                PairPhase::Approved => {
                    return channel
                        .send(&PairReply::Approved {
                            request_id: candidate.request_id,
                            public_key: candidate.public_key,
                            host_id: configured.peer.host_id.clone(),
                        })
                        .await
                }
                PairPhase::Pending if invitation.expires_at > now() => {
                    channel
                        .send(&PairReply::Pending {
                            request_id: candidate.request_id.clone(),
                        })
                        .await?;
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                _ => {
                    channel.send(&PairReply::Denied).await?;
                    return Err(Error::Unauthorized);
                }
            }
        }
    }
    async fn bridge(&self, stream: net::EncryptedStream) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        let mut command = tokio::process::Command::new(&self.bridge);
        command
            .args(["serve", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env("AGENTPORT_DATA_DIR", &self.data_dir);
        if let Some(directory) = &self.host_socket_dir {
            command.env("AGENTPORT_SOCKET_DIR", directory);
        }
        let mut child = command.spawn()?;
        let mut input = child.stdin.take().ok_or(Error::Transport)?;
        let mut output = child.stdout.take().ok_or(Error::Transport)?;
        let (mut reader, mut writer) = tokio::io::split(stream);
        // Dropping this task kills only its Bridge child. Session Hosts are
        // independent processes; no session.stop/archive command is synthesized.
        let result = tokio::select! {
            result = tokio::io::copy(&mut reader, &mut input) => result.map(|_| ()),
            result = async { tokio::io::copy(&mut output, &mut writer).await?; writer.flush().await } => result,
        };
        drop(input);
        let _ = child.start_kill();
        let _ = child.wait().await;
        result.map_err(Into::into)
    }
}
fn reap(inner: &mut Inner) {
    inner.channels.retain(|_, handles| {
        handles.retain(|handle| !handle.is_finished());
        !handles.is_empty()
    });
}
async fn close_channels(handles: Vec<JoinHandle<Result<()>>>) {
    for handle in &handles {
        handle.abort();
    }
    for handle in handles {
        let _ = handle.await;
    }
}

#[cfg(test)]
mod apns_configuration_tests {
    use super::*;
    use base64::Engine as _;
    use ring::{
        rand::SystemRandom,
        signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
    };
    use std::{fs, sync::Mutex as SyncMutex};

    #[derive(Default)]
    struct MemoryVault(SyncMutex<HashMap<String, Zeroizing<Vec<u8>>>>);
    impl Vault for MemoryVault {
        fn load(&self, account: &str) -> Result<Zeroizing<Vec<u8>>> {
            self.0
                .lock()
                .unwrap()
                .get(account)
                .cloned()
                .ok_or(Error::Credential)
        }
        fn create(&self, secret: &[u8]) -> Result<String> {
            let account = identifier()?;
            self.0
                .lock()
                .unwrap()
                .insert(account.clone(), Zeroizing::new(secret.to_vec()));
            Ok(account)
        }
    }
    #[tokio::test]
    async fn apns_import_persists_only_account_and_handles_missing_key_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let bridge = temp.path().join("bridge");
        fs::write(&bridge, "fixture").unwrap();
        let vault = Arc::new(MemoryVault::default());
        let path = temp.path().join("state");
        let runtime = Runtime::open(
            Store::open(&path).unwrap(),
            vault.clone(),
            bridge.clone(),
            temp.path().to_path_buf(),
            None,
        )
        .await
        .unwrap();
        assert!(!runtime.status().await.apns_configured);
        assert!(runtime.apns_credentials().await.unwrap().is_none());
        assert!(runtime
            .configure_apns(
                Zeroizing::new("not-a-key".into()),
                "ABCDEFGHI1".into(),
                "TEAMABCDE1".into(),
                "com.agentport.mobile".into(),
                PushEnvironment::Sandbox
            )
            .await
            .is_err());
        let rng = SystemRandom::new();
        let der = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----",
            base64::engine::general_purpose::STANDARD.encode(der.as_ref())
        );
        runtime
            .configure_apns(
                Zeroizing::new(pem.clone()),
                "ABCDEFGHI1".into(),
                "TEAMABCDE1".into(),
                "com.agentport.mobile".into(),
                PushEnvironment::Sandbox,
            )
            .await
            .unwrap();
        assert!(runtime.status().await.apns_configured);
        assert!(runtime.apns_credentials().await.unwrap().is_some());
        let persisted = fs::read_to_string(path.join("state.json")).unwrap();
        assert!(!persisted.contains(&pem));
        assert!(!persisted.contains("PRIVATE KEY"));
        let account = runtime
            .inner
            .lock()
            .await
            .durable
            .apns
            .as_ref()
            .unwrap()
            .key_account
            .clone();
        drop(runtime);
        let restarted = Runtime::open(
            Store::open(&path).unwrap(),
            vault.clone(),
            bridge.clone(),
            temp.path().to_path_buf(),
            None,
        )
        .await
        .unwrap();
        assert!(restarted.status().await.apns_configured);
        drop(restarted);
        vault.0.lock().unwrap().remove(&account);
        let missing = Runtime::open(
            Store::open(&path).unwrap(),
            vault,
            bridge,
            temp.path().to_path_buf(),
            None,
        )
        .await
        .unwrap();
        assert!(!missing.status().await.apns_configured);
        assert!(matches!(
            missing.apns_credentials().await,
            Err(Error::Credential)
        ));
    }

    #[tokio::test]
    async fn private_ipc_import_does_not_disclose_key_in_status() {
        let temp = tempfile::tempdir().unwrap();
        let bridge = temp.path().join("bridge");
        fs::write(&bridge, "fixture").unwrap();
        let runtime = Runtime::open(
            Store::open(&temp.path().join("state")).unwrap(),
            Arc::new(MemoryVault::default()),
            bridge,
            temp.path().to_path_buf(),
            None,
        )
        .await
        .unwrap();
        let directory = temp.path().join("ipc");
        let server = tokio::spawn({
            let runtime = runtime.clone();
            let directory = directory.clone();
            async move { ipc::serve(&directory, runtime).await.unwrap() }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !directory.join("control.sock").exists() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let der =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----",
            base64::engine::general_purpose::STANDARD.encode(der.as_ref())
        );
        let request = ipc::Request::ConfigureApns {
            key_p8_pem: Zeroizing::new(pem.clone()),
            key_id: "ABCDEFGHI1".into(),
            team_id: "TEAMABCDE1".into(),
            topic: "com.agentport.mobile".into(),
            environment: PushEnvironment::Sandbox,
        };
        assert!(matches!(
            ipc::call(&directory, &request).await.unwrap(),
            ipc::Response::Ok
        ));
        let status = ipc::call(&directory, &ipc::Request::Status).await.unwrap();
        assert!(matches!(&status, ipc::Response::Status { status } if status.apns_configured));
        assert!(!serde_json::to_string(&status).unwrap().contains(&pem));
        runtime.stop().await;
        server.await.unwrap();
    }
}

#[cfg(all(test, feature = "server"))]
mod tests;
