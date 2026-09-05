//! Independent desktop authorization/Bridge owner. GUI uses protected local IPC.
pub mod ipc;
mod storage;
use crate::{
    crypto::{Handshake, Identity},
    endpoint::{PairHello, PairReply},
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
}
impl Default for Persistent {
    fn default() -> Self {
        Self {
            version: VERSION,
            settings: None,
            devices: Vec::new(),
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
        let mut seen = std::collections::HashSet::new();
        for device in &self.devices {
            validate_name(&device.name)?;
            if decode::<32>(&device.public_key)? == [0; 32] || !seen.insert(&device.public_key) {
                return Err(Error::Storage);
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
}
struct Inner {
    durable: Persistent,
    configured: Option<Arc<Configured>>,
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
            devices: inner.durable.devices.clone(),
            pairing: inner.pairing.as_ref().map(|p| p.status.clone()),
            active_channels: inner.channels.values().map(Vec::len).sum(),
        }
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
        let mut inner = self.inner.lock().await;
        if inner.stopping || inner.phase != Phase::Connected {
            return Err(Error::Offline);
        }
        let configured = inner.configured.as_ref().ok_or(Error::Offline)?;
        let invitation = Invitation::new(configured.peer.clone())?;
        inner.pairing = Some(Pairing {
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
                noise.read(&net::receive_packet(&mut socket).await?)?;
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
                    .entry(key)
                    .or_default()
                    .push(tokio::spawn(async move {
                        let _slot = slot;
                        net::send_packet(&mut socket, noise.write(b"accepted")?).await?;
                        let stream = SecureChannel::new(socket, noise.finish()?).into_stream();
                        runtime.bridge(stream).await
                    }));
                Ok(())
            }
        }
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
        {
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

#[cfg(all(test, feature = "server"))]
mod tests;
