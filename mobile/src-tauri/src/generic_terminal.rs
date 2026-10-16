//! Generic terminals never contact AgentPort Bridge. Shell records are shortcuts
//! to new shells; tmux records name one app-owned session, launched only by create.
use crate::{
    credentials::load_credential,
    hosts::{self, HostProfile, PreferredTransport},
    mosh, ssh,
};
use base64::Engine;
use russh::{ChannelMsg, Disconnect};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot};

const TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_CAP: usize = 256 * 1024;
const TMUX_MISSING: &str = "AGENTPORT_TMUX_MISSING";
const SESSION_MISSING: &str = "AGENTPORT_SESSION_MISSING";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_key_hop: Option<&'static str>,
}
fn error(code: &str, message: impl Into<String>) -> TerminalError {
    TerminalError {
        code: code.into(),
        message: message.into(),
        fingerprint: None,
        host_key_hop: None,
    }
}
fn io_error(message: impl Into<String>) -> TerminalError {
    error("terminal_io_failed", message)
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TerminalMode {
    #[default]
    Shell,
    Tmux,
}
fn legacy_terminal_mode() -> TerminalMode {
    TerminalMode::Tmux
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminalRecord {
    id: String,
    profile_id: String,
    name: String,
    #[serde(default = "legacy_terminal_mode")]
    mode: TerminalMode,
    tmux_session: String,
    created_at: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct HostIdentity {
    hostname: String,
    username: String,
    port: u16,
}
impl From<&HostProfile> for HostIdentity {
    fn from(p: &HostProfile) -> Self {
        Self {
            hostname: p.hostname.clone(),
            username: p.username.clone(),
            port: p.port,
        }
    }
}
#[derive(Clone, Deserialize, Serialize)]
struct StoredRecord {
    record: TerminalRecord,
    identity: HostIdentity,
    fingerprint: String,
}

pub struct TerminalConnections {
    // Serializes read/modify/atomic-write operations, including creation intents.
    store: Mutex<()>,
    // Only live create/end operations own gates; expired entries are pruned on
    // lookup so terminal history cannot grow a permanent lock registry.
    lifecycle: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    connections: Mutex<HashMap<String, Arc<LiveConnection>>>,
    permits: Arc<tokio::sync::Semaphore>,
}
impl Default for TerminalConnections {
    fn default() -> Self {
        Self {
            store: Mutex::new(()),
            lifecycle: Mutex::new(HashMap::new()),
            connections: Mutex::new(HashMap::new()),
            permits: Arc::new(tokio::sync::Semaphore::new(16)),
        }
    }
}
impl TerminalConnections {
    async fn lock_lifecycle(
        &self,
        id: &str,
    ) -> Result<tokio::sync::OwnedMutexGuard<()>, TerminalError> {
        let gate = {
            let mut gates = self
                .lifecycle
                .lock()
                .map_err(|_| io_error("Lifecycle lock unavailable"))?;
            gates.retain(|_, gate| gate.strong_count() > 0);
            if let Some(gate) = gates.get(id).and_then(Weak::upgrade) {
                gate
            } else {
                let gate = Arc::new(tokio::sync::Mutex::new(()));
                gates.insert(id.into(), Arc::downgrade(&gate));
                gate
            }
        };
        Ok(gate.lock_owned().await)
    }
}
struct LiveConnection {
    terminal_id: String,
    connection: Connection,
    _permit: tokio::sync::OwnedSemaphorePermit,
}
fn verify_record_key(
    record: &StoredRecord,
    ssh: &ssh::AuthenticatedSsh,
) -> Result<(), TerminalError> {
    if record.fingerprint != ssh.host_key_fingerprint {
        return Err(error("terminal_host_key_changed", "This terminal belongs to a different SSH server key. Refusing to attach or kill it on a replacement server."));
    }
    Ok(())
}
enum Connection {
    Ssh {
        input: mpsc::Sender<Action>,
        output: Mutex<mpsc::Receiver<Vec<u8>>>,
        task: tokio::task::JoinHandle<()>,
    },
    Mosh(String),
}
impl Drop for Connection {
    fn drop(&mut self) {
        if let Self::Ssh { task, .. } = self {
            task.abort();
        }
    }
}
enum Action {
    Input(Vec<u8>, oneshot::Sender<Result<(), TerminalError>>),
    Resize(u16, u16, oneshot::Sender<Result<(), TerminalError>>),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
    profile_id: String,
    name: String,
    #[serde(default)]
    mode: TerminalMode,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectRequest {
    terminal_id: String,
    transport: String,
    cols: u16,
    rows: u16,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputRequest {
    connection_id: String,
    data: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResizeRequest {
    connection_id: String,
    cols: u16,
    rows: u16,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectResult {
    connection_id: String,
}
#[derive(Serialize)]
pub struct PollResult {
    data: Vec<u8>,
    running: bool,
}

fn store_path(app: &AppHandle) -> Result<PathBuf, TerminalError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| io_error(e.to_string()))?
        .join("generic-terminals.json"))
}
fn read_store(path: &PathBuf) -> Result<Vec<StoredRecord>, TerminalError> {
    match std::fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|_| {
            error(
                "terminal_store_invalid",
                "Terminal records are unreadable; no remote action was performed",
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(io_error(e.to_string())),
    }
}
fn write_store(path: &PathBuf, records: &[StoredRecord]) -> Result<(), TerminalError> {
    use std::io::Write;
    let dir = path
        .parent()
        .ok_or_else(|| io_error("Invalid records path"))?;
    std::fs::create_dir_all(dir).map_err(|e| io_error(e.to_string()))?;
    let temp = path.with_extension("json.tmp");
    let mut file = std::fs::File::create(&temp).map_err(|e| io_error(e.to_string()))?;
    file.write_all(&serde_json::to_vec(records).map_err(|e| io_error(e.to_string()))?)
        .map_err(|e| io_error(e.to_string()))?;
    file.sync_all().map_err(|e| io_error(e.to_string()))?;
    std::fs::rename(temp, path).map_err(|e| io_error(e.to_string()))?;
    std::fs::File::open(dir)
        .and_then(|f| f.sync_all())
        .map_err(|e| io_error(e.to_string()))
}
fn valid_tmux(name: &str) -> bool {
    name.strip_prefix("agentport_mobile_")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn profile(app: &AppHandle, id: &str) -> Result<HostProfile, TerminalError> {
    let p = hosts::get_profile(app, id).map_err(|e| error("host_profile_missing", e))?;
    if !p.enabled {
        return Err(error("host_disabled", "Enable this host before connecting"));
    }
    if p.relay.is_some() || matches!(p.preferred_transport, PreferredTransport::Relay) {
        return Err(error(
            "relay_not_supported",
            "Generic terminals require SSH or direct Mosh, not Relay",
        ));
    }
    Ok(p)
}
fn local_record(
    path: &PathBuf,
    state: &TerminalConnections,
    id: &str,
) -> Result<StoredRecord, TerminalError> {
    let _lock = state
        .store
        .lock()
        .map_err(|_| io_error("Records lock unavailable"))?;
    read_store(path)?
        .into_iter()
        .find(|r| r.record.id == id)
        .ok_or_else(|| error("terminal_not_found", "Terminal record not found"))
}
fn stored(
    app: &AppHandle,
    state: &TerminalConnections,
    id: &str,
) -> Result<(StoredRecord, HostProfile), TerminalError> {
    let record = local_record(&store_path(app)?, state, id)?;
    let p = bound_profile(app, &record)?;
    Ok((record, p))
}
fn bound_profile(app: &AppHandle, record: &StoredRecord) -> Result<HostProfile, TerminalError> {
    let p = profile(app, &record.record.profile_id)?;
    if record.identity != HostIdentity::from(&p) {
        return Err(error("host_identity_changed", "Host address, user or port changed; refusing to attach or end this terminal on a different host"));
    }
    if (record.record.mode == TerminalMode::Tmux && !valid_tmux(&record.record.tmux_session))
        || (record.record.mode == TerminalMode::Shell && !record.record.tmux_session.is_empty())
    {
        return Err(error(
            "terminal_store_invalid",
            "Terminal mode and app-owned tmux name do not match",
        ));
    }
    Ok(p)
}
fn authentication(p: &HostProfile) -> ssh::AuthenticationKind {
    match p.authentication {
        hosts::AuthenticationKind::Password => ssh::AuthenticationKind::Password,
        hosts::AuthenticationKind::PrivateKey => ssh::AuthenticationKind::PrivateKey,
    }
}
async fn authenticate(app: &AppHandle, p: &HostProfile) -> Result<SshLease, TerminalError> {
    let jump = p
        .jump
        .as_ref()
        .map(|j| profile(app, &j.host_profile_id))
        .transpose()?;
    if jump.as_ref().is_some_and(|j| j.jump.is_some()) {
        return Err(error(
            "nested_jump_not_supported",
            "Nested SSH jump hosts are not supported",
        ));
    }
    let request = ssh::SshProbeRequest {
        host_profile_id: p.id.clone(),
        hostname: p.hostname.clone(),
        username: p.username.clone(),
        port: p.port,
        credential_id: p.credential_id.clone(),
        authentication: authentication(p),
        expected_host_key: p.trusted_host_key.clone(),
        jump: jump.as_ref().map(|j| ssh::JumpHostRequest {
            host_profile_id: j.id.clone(),
            hostname: j.hostname.clone(),
            username: j.username.clone(),
            port: j.port,
            credential_id: j.credential_id.clone(),
            authentication: authentication(j),
            expected_host_key: j.trusted_host_key.clone(),
        }),
    };
    ssh::validate(&request).map_err(|e| error("invalid_host_profile", e))?;
    let secret =
        load_credential(app, &p.credential_id).map_err(|e| error("credential_unavailable", e))?;
    let jump_secret = jump
        .as_ref()
        .map(|j| load_credential(app, &j.credential_id))
        .transpose()
        .map_err(|e| error("credential_unavailable", e))?;
    tokio::time::timeout(
        TIMEOUT,
        ssh::connect_authenticated_with_jump(
            &request,
            &secret,
            jump_secret.as_deref().map(|s| s.as_slice()),
        ),
    )
    .await
    .map_err(|_| error("ssh_timeout", "SSH authentication timed out"))?
    .map(SshLease::new)
    .map_err(|e| TerminalError {
        code: e.reason.into(),
        message: e.reason.replace('_', " "),
        fingerprint: e.host_key_fingerprint,
        host_key_hop: Some(if e.reason.starts_with("jump_") {
            "jump"
        } else if jump.is_some() {
            "target"
        } else {
            "direct"
        }),
    })
}
// Dropping an IPC future or aborting the PTY actor actively closes the target
// and jump transports, rather than leaving them until keepalive timeout.
struct SshLease(Option<ssh::AuthenticatedSsh>);
impl SshLease {
    fn new(value: ssh::AuthenticatedSsh) -> Self {
        Self(Some(value))
    }
}
impl std::ops::Deref for SshLease {
    type Target = ssh::AuthenticatedSsh;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().expect("live SSH lease")
    }
}
impl Drop for SshLease {
    fn drop(&mut self) {
        if let Some(ssh) = self.0.take() {
            let Ok(runtime) = tokio::runtime::Handle::try_current() else {
                return;
            };
            runtime.spawn(async move {
                let _ = tokio::time::timeout(
                    TIMEOUT,
                    ssh.session
                        .disconnect(Disconnect::ByApplication, "Terminal detached", "en"),
                )
                .await;
                if let Some(jump) = ssh.jump_session {
                    let _ = tokio::time::timeout(
                        TIMEOUT,
                        jump.disconnect(Disconnect::ByApplication, "Terminal detached", "en"),
                    )
                    .await;
                }
            });
        }
    }
}
fn tmux_check() -> String {
    format!("if ! command -v tmux >/dev/null 2>&1; then printf '{TMUX_MISSING}\\n'; exit 127; fi; ")
}
fn existing_check(name: &str) -> String {
    format!("{}if ! tmux has-session -t '={name}' 2>/dev/null; then printf '{SESSION_MISSING}\\n'; exit 44; fi; ", tmux_check())
}
fn control_command(name: &str, action: &str) -> String {
    match action {
        "create" => format!("{}tmux new-session -d -s '{name}'", tmux_check()),
        "end" => format!("{}tmux kill-session -t '={name}'", existing_check(name)),
        _ => format!(
            "{}printf 'AGENTPORT_SESSION_EXISTS\\n'",
            existing_check(name)
        ),
    }
}
async fn create_remote(
    ssh: &ssh::AuthenticatedSsh,
    record: &TerminalRecord,
) -> Result<(), TerminalError> {
    if record.mode == TerminalMode::Tmux {
        control(ssh, control_command(&record.tmux_session, "create")).await?;
    }
    Ok(())
}
async fn check_remote(
    ssh: &ssh::AuthenticatedSsh,
    record: &TerminalRecord,
) -> Result<(), TerminalError> {
    if record.mode == TerminalMode::Tmux {
        control(ssh, control_command(&record.tmux_session, "check")).await?;
    }
    Ok(())
}
fn mosh_command(
    record: &TerminalRecord,
    start: Option<u16>,
    end: Option<u16>,
) -> Result<String, TerminalError> {
    let range = match (start, end) {
        (None, None) => String::new(),
        (Some(start), Some(end)) if start > 0 && start <= end => format!(" -p {start}:{end}"),
        _ => {
            return Err(error(
                "invalid_mosh_port_range",
                "Invalid configured Mosh UDP port range",
            ))
        }
    };
    let (check, command) = match record.mode {
        TerminalMode::Shell => (String::new(), String::new()),
        TerminalMode::Tmux => (
            existing_check(&record.tmux_session),
            format!(" -- tmux attach-session -t '={}'", record.tmux_session),
        ),
    };
    Ok(format!("{check}if ! command -v mosh-server >/dev/null 2>&1; then printf 'AGENTPORT MOSH ERROR missing_mosh_server\\n'; exit 127; fi; case \"$(locale charmap 2>/dev/null)\" in UTF-8|UTF8|utf8) ;; *) if [ \"$(uname -s)\" = Darwin ]; then export LC_CTYPE=UTF-8; else export LC_CTYPE=C.UTF-8; fi ;; esac; exec mosh-server new -s{range}{command}"))
}
async fn control(ssh: &ssh::AuthenticatedSsh, command: String) -> Result<Vec<u8>, TerminalError> {
    tokio::time::timeout(TIMEOUT, async {
        let mut channel = ssh.session.channel_open_session().await.map_err(|e| io_error(e.to_string()))?;
        channel.exec(true, command).await.map_err(|e| io_error(e.to_string()))?;
        let mut output = Vec::new();
        let mut status = None;
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    if output.len() + data.len() > 16384 { return Err(io_error("Control output exceeded 16 KiB")); }
                    output.extend_from_slice(&data);
                }
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                _ => {}
            }
        }
        let text = String::from_utf8_lossy(&output);
        if text.lines().any(|s| s == TMUX_MISSING) { return Err(error("tmux_missing", "tmux is required. Install on the remote host: macOS: brew install tmux; Ubuntu/Debian: sudo apt install tmux; Fedora: sudo dnf install tmux. Then retry.")); }
        if text.lines().any(|s| s == SESSION_MISSING) { return Err(error("tmux_session_missing", "The remote tmux session is missing. Reconnect will not recreate it; explicitly create a new terminal.")); }
        if text.lines().any(|s| s == "AGENTPORT MOSH ERROR missing_mosh_server") { return Err(error("mosh_server_missing", "Install mosh on the remote host (brew install mosh / sudo apt install mosh) and allow its configured UDP range; or use SSH for this terminal.")); }
        if status != Some(0) { return Err(error("remote_command_failed", format!("Remote terminal command failed (exit {status:?})"))); }
        Ok(output)
    }).await.map_err(|_| error("terminal_timeout", "Remote terminal operation timed out; the persisted record is retained. Input and commands were not retried."))?
}

#[tauri::command]
pub fn mobile_terminal_list(
    app: AppHandle,
    terminals: State<'_, TerminalConnections>,
    profile_id: String,
) -> Result<Vec<TerminalRecord>, TerminalError> {
    let _lock = terminals
        .store
        .lock()
        .map_err(|_| io_error("Records lock unavailable"))?;
    Ok(read_store(&store_path(&app)?)?
        .into_iter()
        .filter(|r| r.record.profile_id == profile_id)
        .map(|r| r.record)
        .collect())
}
#[tauri::command]
pub async fn mobile_terminal_create(
    app: AppHandle,
    terminals: State<'_, TerminalConnections>,
    request: CreateRequest,
) -> Result<TerminalRecord, TerminalError> {
    if request.name.trim().is_empty() || request.name.len() > 128 {
        return Err(error(
            "invalid_terminal_name",
            "Terminal name must contain 1–128 bytes",
        ));
    }
    let p = profile(&app, &request.profile_id)?;
    let ssh = authenticate(&app, &p).await?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let record = TerminalRecord {
        id: id.clone(),
        profile_id: p.id.clone(),
        name: request.name.trim().into(),
        mode: request.mode,
        tmux_session: match request.mode {
            TerminalMode::Shell => String::new(),
            TerminalMode::Tmux => format!("agentport_mobile_{id}"),
        },
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| io_error(e.to_string()))?
            .as_millis()
            .to_string(),
    };
    create_saved_record(
        &store_path(&app)?,
        &terminals,
        &ssh,
        StoredRecord {
            record,
            identity: HostIdentity::from(&p),
            fingerprint: ssh.host_key_fingerprint.clone(),
        },
    )
    .await
}
async fn create_saved_record(
    path: &PathBuf,
    terminals: &TerminalConnections,
    ssh: &ssh::AuthenticatedSsh,
    stored: StoredRecord,
) -> Result<TerminalRecord, TerminalError> {
    let record = stored.record.clone();
    // Acquire before publishing the intent, and hold through the remote result.
    // End must not mistake an in-flight create for an already missing session.
    let _lifecycle = terminals.lock_lifecycle(&record.id).await?;
    {
        let _lock = terminals
            .store
            .lock()
            .map_err(|_| io_error("Records lock unavailable"))?;
        let mut records = read_store(path)?;
        if records.len() >= 256 {
            return Err(error(
                "terminal_record_limit",
                "At most 256 persisted terminals are supported; end an old terminal first",
            ));
        }
        records.push(stored);
        write_store(path, &records)?;
    }
    let result = create_remote(ssh, &record).await;
    let _ = ssh
        .session
        .disconnect(Disconnect::ByApplication, "Terminal create complete", "en")
        .await;
    if result.as_ref().is_err_and(|e| e.code == "tmux_missing") {
        let _lock = terminals
            .store
            .lock()
            .map_err(|_| io_error("Records lock unavailable"))?;
        let mut records = read_store(path)?;
        records.retain(|r| r.record.id != record.id);
        write_store(path, &records)?;
    }
    result?;
    Ok(record)
}
#[tauri::command]
pub async fn mobile_terminal_connect(
    app: AppHandle,
    terminals: State<'_, TerminalConnections>,
    mosh_sessions: State<'_, mosh::MoshSessions>,
    request: ConnectRequest,
) -> Result<ConnectResult, TerminalError> {
    let permit = terminals.permits.clone().try_acquire_owned().map_err(|_| {
        error(
            "terminal_connection_limit",
            "At most 16 concurrent terminals are supported",
        )
    })?;
    size(request.cols, request.rows)?;
    if !matches!(request.transport.as_str(), "ssh" | "mosh") {
        return Err(error("invalid_transport", "Choose SSH or Mosh"));
    }
    if request.transport == "mosh" && !cfg!(any(target_os = "ios", target_os = "android")) {
        return Err(error(
            "mosh_runtime_unavailable",
            "Mosh requires an iOS or Android runtime; use SSH for this terminal",
        ));
    }
    let path = store_path(&app)?;
    let (record, p) = stored(&app, &terminals, &request.terminal_id)?;
    let ssh = authenticate(&app, &p).await?;
    verify_record_key(&record, &ssh)?;
    check_remote(&ssh, &record.record).await?;
    let connection = if request.transport == "mosh" {
        let command = mosh_command(&record.record, p.mosh_udp_port_start, p.mosh_udp_port_end)?;
        let output = control(&ssh, command).await?;
        let (port, key) = mosh::bootstrap::parse_connect(&output)
            .map_err(|e| error("mosh_bootstrap_failed", e))?;
        let _ = ssh
            .session
            .disconnect(Disconnect::ByApplication, "Mosh bootstrap complete", "en")
            .await;
        let result = mosh::mobile_mosh_start(
            mosh_sessions.clone(),
            mosh::MoshStartRequest {
                ip: p.hostname,
                port,
                key,
                cols: request.cols,
                rows: request.rows,
                prediction_mode: "adaptive".into(),
            },
        )
        .map_err(|e| error("mosh_start_failed", e))?;
        Connection::Mosh(result.session_id)
    } else {
        ssh_connection(ssh, &record.record, request.cols, request.rows).await?
    };
    register_connection(
        &path,
        &terminals,
        &mosh_sessions,
        request.terminal_id,
        connection,
        permit,
    )
}
fn register_connection(
    path: &PathBuf,
    terminals: &TerminalConnections,
    mosh_sessions: &mosh::MoshSessions,
    terminal_id: String,
    connection: Connection,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<ConnectResult, TerminalError> {
    // Serialize insertion with local deletion: a late connect cannot resurrect a
    // deleted shortcut or leave a new Mosh client outside the cleanup gate.
    let mut pending = Some(connection);
    let result = (|| {
        let _lock = terminals
            .store
            .lock()
            .map_err(|_| io_error("Records lock unavailable"))?;
        if !read_store(path)?.iter().any(|r| r.record.id == terminal_id) {
            return Err(error(
                "terminal_not_found",
                "Terminal record was removed while connecting",
            ));
        }
        let connection_id = format!("terminal_{}", uuid::Uuid::new_v4().simple());
        let mut connections = terminals
            .connections
            .lock()
            .map_err(|_| io_error("Connection state unavailable"))?;
        let live = Arc::new(LiveConnection {
            terminal_id,
            connection: pending.take().expect("pending connection"),
            _permit: permit,
        });
        connections.insert(connection_id.clone(), live);
        Ok(ConnectResult { connection_id })
    })();
    if let Some(connection) = pending {
        stop_connection(&connection, mosh_sessions)?;
    }
    result
}
async fn request_accepted(
    channel: &mut russh::Channel<russh::client::Msg>,
    early_output: &mut Vec<u8>,
    rejection_code: &str,
    description: &str,
) -> Result<(), TerminalError> {
    loop {
        match channel.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) => {
                return Err(error(
                    rejection_code,
                    format!("SSH server rejected {description}"),
                ))
            }
            Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err(error(
                    "ssh_channel_closed",
                    format!("SSH channel closed before accepting {description}"),
                ))
            }
            Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                if early_output.len() + data.len() > OUTPUT_CAP {
                    return Err(io_error("SSH startup output exceeded 256 KiB"));
                }
                early_output.extend_from_slice(&data);
            }
            _ => {}
        }
    }
}
async fn ssh_connection(
    ssh: SshLease,
    record: &TerminalRecord,
    cols: u16,
    rows: u16,
) -> Result<Connection, TerminalError> {
    let (mut channel, early_output) = tokio::time::timeout(TIMEOUT, async {
        let mut channel = ssh
            .session
            .channel_open_session()
            .await
            .map_err(|e| io_error(e.to_string()))?;
        channel
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| io_error(e.to_string()))?;
        let mut early_output = Vec::new();
        request_accepted(
            &mut channel,
            &mut early_output,
            "ssh_pty_rejected",
            "the PTY request",
        )
        .await?;
        match record.mode {
            TerminalMode::Shell => channel.request_shell(true).await,
            TerminalMode::Tmux => {
                channel
                    .exec(
                        true,
                        format!(
                            "{}exec tmux attach-session -t '={}'",
                            existing_check(&record.tmux_session),
                            record.tmux_session
                        ),
                    )
                    .await
            }
        }
        .map_err(|e| io_error(e.to_string()))?;
        let (code, description) = match record.mode {
            TerminalMode::Shell => ("ssh_shell_rejected", "the Shell request"),
            TerminalMode::Tmux => ("ssh_exec_rejected", "the tmux attach request"),
        };
        request_accepted(&mut channel, &mut early_output, code, description).await?;
        Ok::<_, TerminalError>((channel, early_output))
    })
    .await
    .map_err(|_| error("terminal_timeout", "SSH attach timed out"))??;
    let (input, mut rx) = mpsc::channel::<Action>(64);
    let (tx, output) = mpsc::channel(16);
    let task = tokio::spawn(async move {
        // Own both SSH handles for the lifetime of this PTY (including jump).
        let _ssh = ssh;
        if !early_output.is_empty() && tx.send(early_output).await.is_err() {
            let _ = channel.close().await;
            return;
        }
        loop {
            tokio::select! {
                action = rx.recv() => match action {
                    Some(Action::Input(data, done)) => {
                        let result = channel.data(&data[..]).await.map_err(|e| io_error(e.to_string()));
                        let failed = result.is_err(); let _ = done.send(result); if failed { break; }
                    }
                    Some(Action::Resize(cols, rows, done)) => {
                        let result = channel.window_change(cols as u32, rows as u32, 0, 0).await.map_err(|e| io_error(e.to_string()));
                        let failed = result.is_err(); let _ = done.send(result); if failed { break; }
                    }
                    None => break,
                },
                message = channel.wait() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if tx.send(data.to_vec()).await.is_err() { break; }
                    }
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
        }
        let _ = channel.close().await;
    });
    Ok(Connection::Ssh {
        input,
        output: Mutex::new(output),
        task,
    })
}
fn connection(
    terminals: &TerminalConnections,
    id: &str,
) -> Result<Arc<LiveConnection>, TerminalError> {
    terminals
        .connections
        .lock()
        .map_err(|_| io_error("Connection state unavailable"))?
        .get(id)
        .cloned()
        .ok_or_else(|| error("terminal_disconnected", "Terminal is disconnected"))
}
fn size(cols: u16, rows: u16) -> Result<(), TerminalError> {
    if !(1..=500).contains(&cols) || !(1..=500).contains(&rows) {
        return Err(error(
            "invalid_terminal_size",
            "Terminal dimensions must be 1–500",
        ));
    }
    Ok(())
}
async fn send_action(
    input: &mpsc::Sender<Action>,
    action: Action,
    done: oneshot::Receiver<Result<(), TerminalError>>,
) -> Result<(), TerminalError> {
    tokio::time::timeout(TIMEOUT, async {
        input
            .send(action)
            .await
            .map_err(|_| error("terminal_disconnected", "Terminal is disconnected"))?;
        done.await.map_err(|_| {
            error(
                "terminal_disconnected",
                "Terminal disconnected before acknowledgement; input was not retried",
            )
        })?
    })
    .await
    .map_err(|_| {
        error(
            "terminal_input_outcome_unknown",
            "Terminal action timed out; it may have reached the server. It was not retried.",
        )
    })?
}
#[tauri::command]
pub async fn mobile_terminal_input(
    terminals: State<'_, TerminalConnections>,
    mosh_sessions: State<'_, mosh::MoshSessions>,
    request: InputRequest,
) -> Result<(), TerminalError> {
    if request.data.is_empty() || request.data.len() > 65536 {
        return Err(error(
            "invalid_terminal_input",
            "Input must contain 1–65536 bytes",
        ));
    }
    match &connection(&terminals, &request.connection_id)?.connection {
        Connection::Ssh { input, .. } => {
            let (done, ack) = oneshot::channel();
            send_action(input, Action::Input(request.data.into_bytes(), done), ack).await
        }
        Connection::Mosh(id) => mosh::mobile_mosh_input(
            mosh_sessions,
            mosh::MoshInputRequest {
                session_id: id.clone(),
                data_base64: zeroize::Zeroizing::new(
                    base64::engine::general_purpose::STANDARD.encode(request.data.as_bytes()),
                ),
            },
        )
        .map_err(io_error),
    }
}
#[tauri::command]
pub async fn mobile_terminal_resize(
    terminals: State<'_, TerminalConnections>,
    mosh_sessions: State<'_, mosh::MoshSessions>,
    request: ResizeRequest,
) -> Result<(), TerminalError> {
    size(request.cols, request.rows)?;
    match &connection(&terminals, &request.connection_id)?.connection {
        Connection::Ssh { input, .. } => {
            let (done, ack) = oneshot::channel();
            send_action(input, Action::Resize(request.cols, request.rows, done), ack).await
        }
        Connection::Mosh(id) => mosh::mobile_mosh_resize(
            mosh_sessions,
            mosh::MoshResizeRequest {
                session_id: id.clone(),
                cols: request.cols,
                rows: request.rows,
            },
        )
        .map_err(io_error),
    }
}
#[tauri::command]
pub fn mobile_terminal_poll(
    terminals: State<'_, TerminalConnections>,
    mosh_sessions: State<'_, mosh::MoshSessions>,
    connection_id: String,
) -> Result<PollResult, TerminalError> {
    match &connection(&terminals, &connection_id)?.connection {
        Connection::Ssh { output, task, .. } => {
            let mut output = output.lock().map_err(|_| io_error("Output unavailable"))?;
            let mut data = Vec::new();
            while data.len() < OUTPUT_CAP {
                match output.try_recv() {
                    Ok(chunk) => data.extend(chunk),
                    Err(_) => break,
                }
            }
            Ok(PollResult {
                data,
                running: !task.is_finished() || !output.is_empty(),
            })
        }
        Connection::Mosh(id) => {
            let result = mosh::mobile_mosh_poll(mosh_sessions, id.clone()).map_err(io_error)?;
            Ok(PollResult {
                data: base64::engine::general_purpose::STANDARD
                    .decode(result.data_base64)
                    .map_err(|e| io_error(e.to_string()))?,
                running: result.running,
            })
        }
    }
}
#[tauri::command]
pub fn mobile_terminal_disconnect(
    terminals: State<'_, TerminalConnections>,
    mosh_sessions: State<'_, mosh::MoshSessions>,
    connection_id: String,
) -> Result<(), TerminalError> {
    let old = terminals
        .connections
        .lock()
        .map_err(|_| io_error("Connection state unavailable"))?
        .remove(&connection_id);
    if let Some(connection) = old {
        stop_connection(&connection.connection, &mosh_sessions)?;
    }
    Ok(())
}
fn stop_connection(
    connection: &Connection,
    mosh_sessions: &mosh::MoshSessions,
) -> Result<(), TerminalError> {
    match connection {
        Connection::Ssh { task, .. } => task.abort(),
        Connection::Mosh(id) => {
            // Idempotent even when final polling already reaped Mosh.
            mosh::discard_after_stop(mosh_sessions, id).map_err(io_error)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn mobile_terminal_end(
    app: AppHandle,
    terminals: State<'_, TerminalConnections>,
    terminal_id: String,
    mosh_sessions: State<'_, mosh::MoshSessions>,
) -> Result<(), TerminalError> {
    let path = store_path(&app)?;
    end_saved_record(
        &path,
        &terminals,
        &mosh_sessions,
        &terminal_id,
        |record| async move {
            let p = bound_profile(&app, &record)?;
            let ssh = authenticate(&app, &p).await?;
            end_remote(&ssh, &record).await
        },
    )
    .await
}
async fn end_remote(
    ssh: &ssh::AuthenticatedSsh,
    record: &StoredRecord,
) -> Result<(), TerminalError> {
    verify_record_key(record, ssh)?;
    let result = control(ssh, control_command(&record.record.tmux_session, "end")).await;
    let _ = ssh
        .session
        .disconnect(Disconnect::ByApplication, "Terminal end complete", "en")
        .await;
    match result {
        Ok(_) => Ok(()),
        Err(e) if e.code == "tmux_session_missing" => Ok(()),
        Err(e) => Err(e),
    }
}
async fn end_saved_record<F, Fut>(
    path: &PathBuf,
    terminals: &TerminalConnections,
    mosh_sessions: &mosh::MoshSessions,
    terminal_id: &str,
    remote_end: F,
) -> Result<(), TerminalError>
where
    F: FnOnce(StoredRecord) -> Fut,
    Fut: std::future::Future<Output = Result<(), TerminalError>>,
{
    let _lifecycle = terminals.lock_lifecycle(terminal_id).await?;
    let record = local_record(path, terminals, terminal_id)?;
    if record.record.mode == TerminalMode::Tmux {
        remote_end(record).await?;
    }
    // Shell deletion is entirely local, even if the profile was changed or
    // removed. Detach this record's clients; do not promise to kill remote jobs.
    remove_local_record(path, terminals, mosh_sessions, terminal_id)
}
fn remove_local_record(
    path: &PathBuf,
    terminals: &TerminalConnections,
    mosh_sessions: &mosh::MoshSessions,
    terminal_id: &str,
) -> Result<(), TerminalError> {
    let _lock = terminals
        .store
        .lock()
        .map_err(|_| io_error("Records lock unavailable"))?;
    let mut connections = terminals
        .connections
        .lock()
        .map_err(|_| io_error("Connection state unavailable"))?;
    let ids: Vec<_> = connections
        .iter()
        .filter(|(_, c)| c.terminal_id == terminal_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(connection) = connections.remove(&id) {
            stop_connection(&connection.connection, mosh_sessions)?;
        }
    }
    let mut records = read_store(path)?;
    records.retain(|r| r.record.id != terminal_id);
    write_store(path, &records)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_generated_names_are_remote_targets() {
        assert!(valid_tmux(
            "agentport_mobile_0123456789abcdef0123456789abcdef"
        ));
        for s in [
            "user-session",
            "agentport_mobile_; rm -rf",
            "agentport_mobile_",
            "agentport_mobile_0123456789abcdef0123456789abcdef'",
            "agentport_mobile_0123456789abcdef0123456789abcdef:1",
        ] {
            assert!(!valid_tmux(s));
        }
    }
    #[test]
    fn reconnect_and_end_never_create_or_run_display_names() {
        let name = "agentport_mobile_0123456789abcdef0123456789abcdef";
        for action in ["check", "end"] {
            let cmd = control_command(name, action);
            assert!(!cmd.contains("new-session"));
            assert!(cmd.contains(&format!("-t '={name}'")));
            assert!(!cmd.contains("kill-server"));
        }
        assert!(control_command(name, "create").contains("new-session -d"));
    }
    #[test]
    fn persisted_intents_roundtrip_and_identity_is_bound() {
        let path =
            std::env::temp_dir().join(format!("terminal-store-{}.json", uuid::Uuid::new_v4()));
        let identity = HostIdentity {
            hostname: "host".into(),
            username: "user".into(),
            port: 22,
        };
        let records = vec![StoredRecord {
            record: TerminalRecord {
                id: "id".into(),
                profile_id: "p".into(),
                name: "'; evil".into(),
                mode: TerminalMode::Tmux,
                tmux_session: "agentport_mobile_0123456789abcdef0123456789abcdef".into(),
                created_at: "1".into(),
            },
            identity: identity.clone(),
            fingerprint: "SHA256:fixture".into(),
        }];
        write_store(&path, &records).unwrap();
        let loaded = read_store(&path).unwrap();
        assert_eq!(loaded[0].record.name, "'; evil");
        assert_eq!(loaded[0].identity, identity);
        let mut changed = identity.clone();
        changed.port = 23;
        assert_ne!(loaded[0].identity, changed);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn legacy_records_are_tmux_but_new_requests_default_to_shell() {
        let legacy = serde_json::json!({
            "id": "old", "profileId": "host", "name": "existing tmux",
            "tmuxSession": "agentport_mobile_0123456789abcdef0123456789abcdef",
            "createdAt": "1"
        });
        let record: TerminalRecord = serde_json::from_value(legacy).unwrap();
        assert_eq!(record.mode, TerminalMode::Tmux);
        assert_eq!(serde_json::to_value(&record).unwrap()["mode"], "tmux");
        let request: CreateRequest = serde_json::from_value(serde_json::json!({
            "profileId": "host", "name": "new shell"
        }))
        .unwrap();
        assert_eq!(request.mode, TerminalMode::Shell);
        let request: CreateRequest = serde_json::from_value(serde_json::json!({
            "profileId": "host", "name": "new tmux", "mode": "tmux"
        }))
        .unwrap();
        assert_eq!(request.mode, TerminalMode::Tmux);
        assert!(serde_json::from_value::<CreateRequest>(serde_json::json!({
            "profileId": "host", "name": "bad", "mode": "other"
        }))
        .is_err());
    }
    #[test]
    fn invalid_requests_are_structured_errors() {
        assert!(size(0, 24).is_err());
        assert!(size(80, 501).is_err());
        assert!(size(80, 24).is_ok());
        let serialized =
            serde_json::to_value(error("tmux_session_missing", "Never recreated")).unwrap();
        assert_eq!(serialized["code"], "tmux_session_missing");
        assert!(serialized.get("fingerprint").is_none());
    }
    #[derive(Default)]
    struct CreatePause {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    #[derive(Clone)]
    struct Fixture {
        socket: String,
        allow_tmux: bool,
        reject_request: Option<&'static str>,
        early_output: Vec<u8>,
        create_pause: Option<Arc<CreatePause>>,
        commands: Arc<Mutex<Vec<String>>>,
        shells: Arc<Mutex<usize>>,
        received: Arc<Mutex<Vec<u8>>>,
        dimensions: Arc<Mutex<Vec<(u32, u32)>>>,
    }
    impl russh::server::Server for Fixture {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }
    impl russh::server::Handler for Fixture {
        type Error = russh::Error;
        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(if user == "fixture" && password == "secret" {
                russh::server::Auth::Accept
            } else {
                russh::server::Auth::Reject {
                    proceed_with_methods: None,
                    partial_success: false,
                }
            })
        }
        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }
        async fn pty_request(
            &mut self,
            channel: russh::ChannelId,
            term: &str,
            cols: u32,
            rows: u32,
            _: u32,
            _: u32,
            _: &[(russh::Pty, u32)],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            assert_eq!(term, "xterm-256color");
            self.dimensions.lock().unwrap().push((cols, rows));
            if self.reject_request == Some("close_pty") {
                session.close(channel)?;
            } else if self.reject_request == Some("pty") {
                session.channel_failure(channel)?;
            } else {
                if !self.early_output.is_empty() {
                    session.data(channel, self.early_output.clone())?;
                }
                session.channel_success(channel)?;
            }
            Ok(())
        }
        async fn window_change_request(
            &mut self,
            _: russh::ChannelId,
            cols: u32,
            rows: u32,
            _: u32,
            _: u32,
            _: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.dimensions.lock().unwrap().push((cols, rows));
            Ok(())
        }
        async fn shell_request(
            &mut self,
            channel: russh::ChannelId,
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            *self.shells.lock().unwrap() += 1;
            if self.reject_request == Some("close_shell") {
                session.close(channel)?;
            } else if self.reject_request == Some("shell") {
                session.channel_failure(channel)?;
            } else {
                // Servers may send welcome bytes before acknowledging Shell.
                session.data(channel, vec![0xff, 0x00, b'S'])?;
                session.channel_success(channel)?;
            }
            Ok(())
        }
        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            command: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            let command = std::str::from_utf8(command).unwrap();
            assert!(!command.contains("agentport-remote-bridge"));
            self.commands.lock().unwrap().push(command.into());
            if command.contains("tmux new-session -d") {
                if let Some(pause) = &self.create_pause {
                    pause.entered.notify_one();
                    pause.release.notified().await;
                }
            }
            if self.reject_request == Some("close_exec") {
                session.close(channel)?;
                return Ok(());
            }
            if self.reject_request == Some("exec") {
                session.channel_failure(channel)?;
                return Ok(()); // Deliberately keep the rejected channel open.
            }
            session.channel_success(channel)?;
            if !self.allow_tmux {
                // This server has no tmux command path, but accepts standard
                // Shell requests and a fake mosh-server bootstrap handshake.
                if command.contains("tmux") {
                    session.data(channel, format!("{TMUX_MISSING}\n").into_bytes())?;
                    session.exit_status_request(channel, 127)?;
                } else {
                    assert!(command.contains("exec mosh-server new -s"));
                    session.data(
                        channel,
                        b"MOSH CONNECT 60001 AAAAAAAAAAAAAAAAAAAAAA\n".to_vec(),
                    )?;
                    session.exit_status_request(channel, 0)?;
                }
                session.eof(channel)?;
                session.close(channel)?;
            } else if command.contains("exec tmux attach-session") {
                // The PTY protocol is independently exercised as a byte echo;
                // control commands below execute real tmux on a fixture-only socket.
                session.data(channel, vec![0xff, 0x00, b'R'])?;
            } else {
                let command = command.replace("tmux ", &format!("tmux -L {} ", self.socket));
                let result = std::process::Command::new("/bin/sh")
                    .arg("-c")
                    .arg(command)
                    .env("PATH", "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
                    .output()
                    .unwrap();
                session.data(channel, result.stdout)?;
                session.extended_data(channel, 1, result.stderr)?;
                session.exit_status_request(channel, result.status.code().unwrap_or(1) as u32)?;
                session.eof(channel)?;
                session.close(channel)?;
            }
            Ok(())
        }
        async fn data(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.received.lock().unwrap().extend_from_slice(data);
            session.data(channel, data.to_vec())?;
            Ok(())
        }
    }
    async fn start_fixture(
        fixture: Fixture,
    ) -> (ssh::SshProbeRequest, tokio::task::JoinHandle<()>) {
        use russh::server::Server as _;
        let key = russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let config = russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(1),
            ..Default::default()
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut fixture = fixture;
            fixture
                .run_on_socket(Arc::new(config), &listener)
                .await
                .unwrap();
        });
        (
            ssh::SshProbeRequest {
                host_profile_id: "fixture".into(),
                hostname: "127.0.0.1".into(),
                port,
                username: "fixture".into(),
                credential_id: "fixture".into(),
                authentication: ssh::AuthenticationKind::Password,
                expected_host_key: Some(fingerprint),
                jump: None,
            },
            server,
        )
    }
    #[tokio::test]
    async fn rejected_pty_shell_and_exec_never_publish_ready_connections() {
        for (rejected, expected) in [
            ("pty", "ssh_pty_rejected"),
            ("shell", "ssh_shell_rejected"),
            ("exec", "ssh_exec_rejected"),
            ("close_pty", "ssh_channel_closed"),
            ("close_shell", "ssh_channel_closed"),
            ("close_exec", "ssh_channel_closed"),
        ] {
            let fixture = Fixture {
                socket: String::new(),
                allow_tmux: rejected.ends_with("exec"),
                reject_request: Some(rejected),
                early_output: vec![0x00, 0xff, b'P'],
                create_pause: None,
                commands: Arc::new(Mutex::new(Vec::new())),
                shells: Arc::new(Mutex::new(0)),
                received: Arc::new(Mutex::new(Vec::new())),
                dimensions: Arc::new(Mutex::new(Vec::new())),
            };
            let commands = fixture.commands.clone();
            let shells = fixture.shells.clone();
            let (request, server) = start_fixture(fixture).await;
            let ssh = SshLease::new(
                ssh::connect_authenticated(&request, b"secret")
                    .await
                    .map_err(|e| e.reason)
                    .unwrap(),
            );
            let terminal = TerminalRecord {
                id: "reject".into(),
                profile_id: "fixture".into(),
                name: "display".into(),
                mode: if rejected.ends_with("exec") {
                    TerminalMode::Tmux
                } else {
                    TerminalMode::Shell
                },
                tmux_session: if rejected.ends_with("exec") {
                    "agentport_mobile_0123456789abcdef0123456789abcdef".into()
                } else {
                    String::new()
                },
                created_at: "1".into(),
            };
            let result = tokio::time::timeout(
                Duration::from_secs(2),
                ssh_connection(ssh, &terminal, 80, 24),
            )
            .await
            .expect("request refusal must fail promptly without waiting for channel close");
            assert!(
                result.is_err(),
                "{rejected} refusal was incorrectly returned as a ready connection"
            );
            assert_eq!(result.err().unwrap().code, expected);
            if rejected.ends_with("pty") {
                assert_eq!(*shells.lock().unwrap(), 0);
                assert!(commands.lock().unwrap().is_empty());
            }
            server.abort();
        }
    }
    #[tokio::test]
    async fn startup_acceptance_preserves_early_pty_and_shell_bytes() {
        let early = vec![0x00, 0xff, b'P'];
        let fixture = Fixture {
            socket: String::new(),
            allow_tmux: false,
            reject_request: None,
            early_output: early.clone(),
            create_pause: None,
            commands: Arc::new(Mutex::new(Vec::new())),
            shells: Arc::new(Mutex::new(0)),
            received: Arc::new(Mutex::new(Vec::new())),
            dimensions: Arc::new(Mutex::new(Vec::new())),
        };
        let (request, server) = start_fixture(fixture).await;
        let ssh = SshLease::new(
            ssh::connect_authenticated(&request, b"secret")
                .await
                .map_err(|e| e.reason)
                .unwrap(),
        );
        let terminal = TerminalRecord {
            id: "early".into(),
            profile_id: "fixture".into(),
            name: "display".into(),
            mode: TerminalMode::Shell,
            tmux_session: String::new(),
            created_at: "1".into(),
        };
        let actor = ssh_connection(ssh, &terminal, 80, 24).await.unwrap();
        let Connection::Ssh { output, .. } = &actor else {
            unreachable!()
        };
        let mut data = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), async {
            while data.len() < early.len() + 3 {
                while let Ok(chunk) = output.lock().unwrap().try_recv() {
                    data.extend(chunk);
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(data, [early, vec![0xff, 0x00, b'S']].concat());
        drop(actor);
        server.abort();
    }
    #[tokio::test]
    async fn lifecycle_gates_retain_only_live_operations() {
        let terminals = TerminalConnections::default();
        let active = terminals.lock_lifecycle("active").await.unwrap();
        for i in 0..256 {
            let gate = terminals
                .lock_lifecycle(&format!("ended-{i}"))
                .await
                .unwrap();
            assert!(terminals.lifecycle.lock().unwrap().len() <= 2);
            drop(gate);
        }
        drop(active);
        let _last = terminals.lock_lifecycle("last").await.unwrap();
        assert_eq!(terminals.lifecycle.lock().unwrap().len(), 1);
    }
    struct FixtureSocket(String);
    impl Drop for FixtureSocket {
        fn drop(&mut self) {
            let _ = std::process::Command::new("/opt/homebrew/bin/tmux")
                .args(["-L", &self.0, "kill-server"])
                .output();
        }
    }
    #[tokio::test]
    async fn end_waits_for_pending_tmux_create_without_orphaning_remote_session() {
        use std::{
            future::Future,
            sync::atomic::{AtomicBool, Ordering},
            task::Poll,
        };
        if !std::path::Path::new("/opt/homebrew/bin/tmux").exists() {
            eprintln!("SKIP: fixture requires /opt/homebrew/bin/tmux");
            return;
        }
        let socket = FixtureSocket(format!(
            "agentport-create-race-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let pause = Arc::new(CreatePause::default());
        let fixture = Fixture {
            socket: socket.0.clone(),
            allow_tmux: true,
            reject_request: None,
            early_output: Vec::new(),
            create_pause: Some(pause.clone()),
            commands: Arc::new(Mutex::new(Vec::new())),
            shells: Arc::new(Mutex::new(0)),
            received: Arc::new(Mutex::new(Vec::new())),
            dimensions: Arc::new(Mutex::new(Vec::new())),
        };
        let commands = fixture.commands.clone();
        let (request, server) = start_fixture(fixture).await;
        let request = Arc::new(request);
        let path = std::env::temp_dir().join(format!(
            "terminal-create-race-{}.json",
            uuid::Uuid::new_v4()
        ));
        let terminals = Arc::new(TerminalConnections::default());
        let mosh_sessions = mosh::MoshSessions::default();
        let id = uuid::Uuid::new_v4().simple().to_string();
        let name = format!("agentport_mobile_{id}");
        let stored = StoredRecord {
            record: TerminalRecord {
                id: id.clone(),
                profile_id: "fixture".into(),
                name: "display".into(),
                mode: TerminalMode::Tmux,
                tmux_session: name.clone(),
                created_at: "1".into(),
            },
            identity: HostIdentity {
                hostname: request.hostname.clone(),
                username: request.username.clone(),
                port: request.port,
            },
            fingerprint: request.expected_host_key.clone().unwrap(),
        };
        let create_request = request.clone();
        let create_path = path.clone();
        let create_state = terminals.clone();
        let creating = tokio::spawn(async move {
            let ssh = SshLease::new(
                ssh::connect_authenticated(&create_request, b"secret")
                    .await
                    .map_err(|e| e.reason)
                    .unwrap(),
            );
            create_saved_record(&create_path, &create_state, &ssh, stored).await
        });
        tokio::time::timeout(Duration::from_secs(5), pause.entered.notified())
            .await
            .unwrap();
        assert_eq!(read_store(&path).unwrap().len(), 1); // Intent already visible.
        let end_started = AtomicBool::new(false);
        let end_request = request.clone();
        let mut ending = Box::pin(end_saved_record(
            &path,
            &terminals,
            &mosh_sessions,
            &id,
            |record| {
                end_started.store(true, Ordering::SeqCst);
                async move {
                    let ssh = SshLease::new(
                        ssh::connect_authenticated(&end_request, b"secret")
                            .await
                            .map_err(|e| e.reason)
                            .unwrap(),
                    );
                    end_remote(&ssh, &record).await
                }
            },
        ));
        // One explicit poll distinguishes blocking on the lifecycle gate from
        // starting remote End while Create is paused. No scheduler sleeps.
        let polled = std::future::poll_fn(|cx| Poll::Ready(ending.as_mut().poll(cx))).await;
        assert!(polled.is_pending());
        let end_started_before_release = end_started.load(Ordering::SeqCst);
        if end_started_before_release {
            // Faulty implementation deletes the missing session's intent before
            // the paused remote create runs; finish that ordering deterministically.
            ending.as_mut().await.unwrap();
        }
        pause.release.notify_one();
        tokio::time::timeout(Duration::from_secs(5), creating)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if !end_started_before_release {
            tokio::time::timeout(Duration::from_secs(5), ending)
                .await
                .unwrap()
                .unwrap();
        }
        let ssh = SshLease::new(
            ssh::connect_authenticated(&request, b"secret")
                .await
                .map_err(|e| e.reason)
                .unwrap(),
        );
        let checked = control(&ssh, control_command(&name, "check")).await;
        assert!(
            checked.is_err(),
            "End deleted the record but pending Create left an orphan tmux session"
        );
        assert_eq!(checked.unwrap_err().code, "tmux_session_missing");
        assert!(read_store(&path).unwrap().is_empty());
        assert!(
            !end_started_before_release,
            "End must wait for Create before checking/ending the remote session"
        );
        let commands = commands.lock().unwrap();
        assert!(commands
            .iter()
            .any(|c| c.contains(&format!("tmux kill-session -t '={name}'"))));
        assert!(commands.iter().all(|c| !c.contains("kill-server")));
        std::fs::remove_file(&path).unwrap();
        server.abort();
    }
    #[tokio::test]
    async fn no_tmux_shell_routes_preserve_bytes_resize_and_delete_locally() {
        use russh::server::Server as _;
        let fixture = Fixture {
            socket: String::new(),
            allow_tmux: false,
            reject_request: None,
            early_output: Vec::new(),
            create_pause: None,
            commands: Arc::new(Mutex::new(Vec::new())),
            shells: Arc::new(Mutex::new(0)),
            received: Arc::new(Mutex::new(Vec::new())),
            dimensions: Arc::new(Mutex::new(Vec::new())),
        };
        let commands = fixture.commands.clone();
        let shells = fixture.shells.clone();
        let received = fixture.received.clone();
        let dimensions = fixture.dimensions.clone();
        let key = russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let config = russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(1),
            ..Default::default()
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut fixture = fixture;
            fixture
                .run_on_socket(Arc::new(config), &listener)
                .await
                .unwrap();
        });
        let request = ssh::SshProbeRequest {
            host_profile_id: "fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "fixture".into(),
            credential_id: "fixture".into(),
            authentication: ssh::AuthenticationKind::Password,
            expected_host_key: Some(fingerprint.clone()),
            jump: None,
        };
        let ssh = SshLease::new(
            ssh::connect_authenticated(&request, b"secret")
                .await
                .map_err(|e| e.reason)
                .unwrap(),
        );
        let terminal = TerminalRecord {
            id: "shell".into(),
            profile_id: "deleted-profile".into(),
            name: "not a remote command; ' ".into(),
            mode: TerminalMode::Shell,
            tmux_session: String::new(),
            created_at: "1".into(),
        };
        // The same authenticated fixture explicitly rejects tmux. The actual
        // production create/check routes for Shell send no remote command.
        let mut tmux = terminal.clone();
        tmux.mode = TerminalMode::Tmux;
        tmux.tmux_session = format!("agentport_mobile_{}", uuid::Uuid::new_v4().simple());
        assert_eq!(
            create_remote(&ssh, &tmux).await.unwrap_err().code,
            "tmux_missing"
        );
        commands.lock().unwrap().clear();
        create_remote(&ssh, &terminal).await.unwrap();
        check_remote(&ssh, &terminal).await.unwrap();
        assert!(commands.lock().unwrap().is_empty());
        assert_eq!(serde_json::to_value(&terminal).unwrap()["tmuxSession"], "");
        assert_eq!(serde_json::to_value(&terminal).unwrap()["mode"], "shell");

        // Exercise the production Mosh command + bounded SSH control reader.
        // No Mosh FFI/UDP client is started in this desktop-only fixture.
        for (start, end) in [(None, None), (Some(60000), Some(60010))] {
            let command = mosh_command(&terminal, start, end).unwrap();
            assert!(!command.contains("tmux"));
            assert!(!command.contains(" -- "));
            let suffix = if start.is_some() {
                "new -s -p 60000:60010"
            } else {
                "new -s"
            };
            assert!(command.ends_with(suffix));
            let output = control(&ssh, command).await.unwrap();
            assert_eq!(mosh::bootstrap::parse_connect(&output).unwrap().0, 60001);
        }
        assert_eq!(
            mosh_command(&terminal, Some(60001), None).unwrap_err().code,
            "invalid_mosh_port_range"
        );
        assert!(mosh_command(&terminal, Some(0), Some(60000)).is_err());
        assert!(mosh_command(&terminal, Some(60001), Some(60000)).is_err());
        let tmux_mosh = mosh_command(&tmux, None, None).unwrap();
        assert!(tmux_mosh.contains("tmux has-session"));
        assert!(tmux_mosh.ends_with(&format!(
            " -- tmux attach-session -t '={}'",
            tmux.tmux_session
        )));
        commands.lock().unwrap().clear();

        let stored = StoredRecord {
            record: terminal.clone(),
            identity: HostIdentity {
                hostname: "old-invalid-host".into(),
                username: "old-user".into(),
                port: 1,
            },
            fingerprint,
        };
        verify_record_key(&stored, &ssh).unwrap();
        let mut wrong_key = stored.clone();
        wrong_key.fingerprint = "SHA256:replacement".into();
        assert_eq!(
            verify_record_key(&wrong_key, &ssh).unwrap_err().code,
            "terminal_host_key_changed"
        );
        let path =
            std::env::temp_dir().join(format!("terminal-shell-{}.json", uuid::Uuid::new_v4()));
        let mut other = stored.clone();
        other.record.id = "other".into();
        write_store(&path, &[stored, other]).unwrap();
        let terminals = TerminalConnections::default();
        let mosh_sessions = mosh::MoshSessions::default();
        let actor = ssh_connection(ssh, &terminal, 80, 24).await.unwrap();
        let registered = register_connection(
            &path,
            &terminals,
            &mosh_sessions,
            terminal.id.clone(),
            actor,
            terminals.permits.clone().try_acquire_owned().unwrap(),
        )
        .unwrap();
        let live = connection(&terminals, &registered.connection_id).unwrap();
        let Connection::Ssh { input, output, .. } = &live.connection else {
            unreachable!()
        };
        let input = input.clone();
        let bytes = b"a\x00\x03\x1b[200~\xe4\xb8\xad\x1b[201~".to_vec();
        let (done, ack) = oneshot::channel();
        send_action(&input, Action::Input(bytes.clone(), done), ack)
            .await
            .unwrap();
        let (done, ack) = oneshot::channel();
        send_action(&input, Action::Resize(123, 45, done), ack)
            .await
            .unwrap();
        let mut polled = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                while let Ok(chunk) = output.lock().unwrap().try_recv() {
                    polled.extend(chunk);
                }
                if polled.len() >= bytes.len() + 3 && dimensions.lock().unwrap().len() == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(&polled[..3], &[0xff, 0x00, b'S']);
        assert_eq!(&polled[3..], &bytes);
        assert_eq!(*received.lock().unwrap(), bytes);
        assert_eq!(*dimensions.lock().unwrap(), vec![(80, 24), (123, 45)]);
        assert_eq!(*shells.lock().unwrap(), 1);
        assert!(commands.lock().unwrap().is_empty());
        drop(live);

        // Deleted/changed/unreachable host data is irrelevant to local removal.
        // Removing one shortcut detaches its client without touching another.
        end_saved_record(&path, &terminals, &mosh_sessions, "shell", |_| async {
            Err(io_error(
                "Shell deletion must not authenticate or run remote End",
            ))
        })
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), input.closed())
            .await
            .unwrap();
        assert!(connection(&terminals, &registered.connection_id).is_err());
        let records = read_store(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].record.id, "other");

        // A late asynchronous connect cannot resurrect the deleted shortcut.
        // A new Shell request is made; no input is replayed into that new shell.
        let ssh = SshLease::new(
            ssh::connect_authenticated(&request, b"secret")
                .await
                .map_err(|e| e.reason)
                .unwrap(),
        );
        let actor = ssh_connection(ssh, &terminal, 80, 24).await.unwrap();
        // request_shell queues the SSH request; wait for server observation,
        // not merely local enqueue, before simulating late registration.
        tokio::time::timeout(Duration::from_secs(5), async {
            while *shells.lock().unwrap() != 2 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let Connection::Ssh {
            input: late_input, ..
        } = &actor
        else {
            unreachable!()
        };
        let late_input = late_input.clone();
        let failure = register_connection(
            &path,
            &terminals,
            &mosh_sessions,
            terminal.id.clone(),
            actor,
            terminals.permits.clone().try_acquire_owned().unwrap(),
        )
        .err()
        .unwrap();
        assert_eq!(failure.code, "terminal_not_found");
        tokio::time::timeout(Duration::from_secs(5), late_input.closed())
            .await
            .unwrap();
        assert_eq!(*shells.lock().unwrap(), 2);
        assert_eq!(*received.lock().unwrap(), bytes);
        assert!(commands.lock().unwrap().is_empty());
        assert_eq!(terminals.permits.available_permits(), 16);
        std::fs::remove_file(path).unwrap();
        server.abort();
    }
    #[tokio::test]
    async fn real_ssh_tmux_control_and_pty_actor_preserve_bytes_and_detach() {
        use russh::server::Server as _;
        if !std::path::Path::new("/opt/homebrew/bin/tmux").exists() {
            eprintln!("SKIP: fixture requires /opt/homebrew/bin/tmux");
            return;
        }
        let socket = FixtureSocket(format!("agentport-test-{}", uuid::Uuid::new_v4().simple()));
        let fixture = Fixture {
            socket: socket.0.clone(),
            allow_tmux: true,
            reject_request: None,
            early_output: Vec::new(),
            create_pause: None,
            commands: Arc::new(Mutex::new(Vec::new())),
            shells: Arc::new(Mutex::new(0)),
            received: Arc::new(Mutex::new(Vec::new())),
            dimensions: Arc::new(Mutex::new(Vec::new())),
        };
        let received = fixture.received.clone();
        let dimensions = fixture.dimensions.clone();
        let key = russh::keys::PrivateKey::random(
            &mut rand::rng(),
            russh::keys::ssh_key::Algorithm::Ed25519,
        )
        .unwrap();
        let fingerprint = key
            .public_key()
            .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
            .to_string();
        let config = russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(1),
            ..Default::default()
        };
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let mut fixture = fixture;
            fixture
                .run_on_socket(Arc::new(config), &listener)
                .await
                .unwrap();
        });
        let mut request = ssh::SshProbeRequest {
            host_profile_id: "fixture".into(),
            hostname: "127.0.0.1".into(),
            port,
            username: "fixture".into(),
            credential_id: "fixture".into(),
            authentication: ssh::AuthenticationKind::Password,
            expected_host_key: None,
            jump: None,
        };
        let failure = ssh::connect_authenticated(&request, b"secret")
            .await
            .err()
            .unwrap();
        assert_eq!(failure.reason, "host_key_confirmation_required");
        assert_eq!(
            failure.host_key_fingerprint.as_deref(),
            Some(fingerprint.as_str())
        );
        request.expected_host_key = Some(fingerprint.clone());
        let ssh = SshLease::new(
            ssh::connect_authenticated(&request, b"secret")
                .await
                .map_err(|e| e.reason)
                .unwrap(),
        );
        let name = format!("agentport_mobile_{}", uuid::Uuid::new_v4().simple());
        let missing = control(&ssh, control_command(&name, "check"))
            .await
            .unwrap_err();
        assert_eq!(missing.code, "tmux_session_missing");
        control(&ssh, control_command(&name, "create"))
            .await
            .unwrap();
        control(&ssh, control_command(&name, "check"))
            .await
            .unwrap();
        let terminal = TerminalRecord {
            id: "tmux".into(),
            profile_id: "fixture".into(),
            name: "display".into(),
            mode: TerminalMode::Tmux,
            tmux_session: name.clone(),
            created_at: "1".into(),
        };
        let actor = ssh_connection(ssh, &terminal, 80, 24).await.unwrap();
        let Connection::Ssh { input, output, .. } = &actor else {
            unreachable!()
        };
        let bytes = b"a\x00\x03\x1b[200~\xe4\xb8\xad\x1b[201~".to_vec();
        let (done, ack) = oneshot::channel();
        send_action(input, Action::Input(bytes.clone(), done), ack)
            .await
            .unwrap();
        let (done, ack) = oneshot::channel();
        send_action(input, Action::Resize(123, 45, done), ack)
            .await
            .unwrap();
        let mut polled = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                while let Ok(chunk) = output.lock().unwrap().try_recv() {
                    polled.extend(chunk);
                }
                if polled.len() >= bytes.len() + 3 && dimensions.lock().unwrap().len() == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(&polled[..3], &[0xff, 0x00, b'R']);
        assert_eq!(&polled[3..], &bytes);
        assert_eq!(*received.lock().unwrap(), bytes);
        assert_eq!(*dimensions.lock().unwrap(), vec![(80, 24), (123, 45)]);
        // Reusable authenticator's keepalive must keep an idle terminal alive
        // beyond its 15s inactivity deadline, without replaying previous input.
        tokio::time::sleep(Duration::from_secs(16)).await;
        let (done, ack) = oneshot::channel();
        send_action(input, Action::Input(b"idle".to_vec(), done), ack)
            .await
            .unwrap();
        drop(actor);
        let ssh = SshLease::new(
            ssh::connect_authenticated(&request, b"secret")
                .await
                .map_err(|e| e.reason)
                .unwrap(),
        );
        control(&ssh, control_command(&name, "check"))
            .await
            .unwrap(); // detach preserved remote session
        let record = StoredRecord {
            record: TerminalRecord {
                id: "id".into(),
                profile_id: "fixture".into(),
                name: "display".into(),
                mode: TerminalMode::Tmux,
                tmux_session: name.clone(),
                created_at: "1".into(),
            },
            identity: HostIdentity {
                hostname: "127.0.0.1".into(),
                username: "fixture".into(),
                port,
            },
            fingerprint: "SHA256:replacement".into(),
        };
        assert_eq!(
            verify_record_key(&record, &ssh).unwrap_err().code,
            "terminal_host_key_changed"
        );
        control(&ssh, control_command(&name, "end")).await.unwrap();
        assert_eq!(
            control(&ssh, control_command(&name, "check"))
                .await
                .unwrap_err()
                .code,
            "tmux_session_missing"
        );
        server.abort();
    }
}
