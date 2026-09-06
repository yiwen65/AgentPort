//! Bounded same-user Unix IPC. Socket lives in an owned 0700 directory; no TCP.
use super::{private_directory, Candidate, Runtime, Status, Store};
use crate::{
    protocol::{host_id, Invitation, VERSION},
    Error, Result,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{UnixListener, UnixStream},
    sync::Semaphore,
    task::JoinSet,
};
use zeroize::Zeroizing;
const MAX_REQUEST: usize = 8192;
const MAX_RESPONSE: usize = 65536;

// No Debug: Configure contains a deployment token.
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    Configure {
        relay_url: String,
        name: String,
        token: Zeroizing<String>,
    },
    Invite,
    InviteAutomatic,
    Decide {
        invitation_id: String,
        candidate: Candidate,
        approve: bool,
    },
    CloseInvitation {
        invitation_id: String,
    },
    Revoke {
        public_key: String,
    },
    Stop,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Status { status: Status },
    Invitation { invitation: Invitation },
    Ok,
    Error { message: String },
}

/// Bundle directory AND data root isolate debug/release/checkouts while remaining
/// stable across GUI restarts/updates at the same install path.
pub fn namespace(bundle_bin: &Path, data_root: &Path) -> Result<String> {
    let bundle = fs::canonicalize(bundle_bin).map_err(|_| Error::Storage)?;
    let data = fs::canonicalize(data_root).map_err(|_| Error::Storage)?;
    Ok(host_id(&serde_json::to_vec(&(bundle, data))?)[..20].to_string())
}
pub fn socket_directory(namespace: &str) -> Result<PathBuf> {
    if namespace.len() != 20
        || !namespace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(Error::Storage);
    }
    // /tmp is intentionally short for Darwin's 104-byte sockaddr_un limit.
    private_directory(&PathBuf::from(format!(
        "/tmp/agentport-relay-{}-{namespace}",
        unsafe { libc::geteuid() }
    )))
}
pub fn state_directory(data_root: &Path, namespace: &str) -> Result<PathBuf> {
    if namespace.len() != 20
        || !namespace
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err(Error::Storage);
    }
    let parent = private_directory(&data_root.join("relay-connectors"))?;
    private_directory(&parent.join(namespace))
}
async fn read<T: DeserializeOwned>(socket: &mut UnixStream, max: usize) -> Result<T> {
    let length = socket.read_u32().await? as usize;
    if length == 0 || length > max {
        return Err(Error::Protocol);
    }
    let mut bytes = Zeroizing::new(vec![0; length]);
    socket.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
async fn write<T: Serialize>(socket: &mut UnixStream, value: &T, max: usize) -> Result<()> {
    let bytes = Zeroizing::new(serde_json::to_vec(value)?);
    if bytes.is_empty() || bytes.len() > max {
        return Err(Error::Protocol);
    }
    socket.write_u32(bytes.len() as u32).await?;
    socket.write_all(&bytes).await?;
    socket.flush().await?;
    Ok(())
}
fn peer(socket: &UnixStream) -> Result<()> {
    if socket.peer_cred()?.uid() != unsafe { libc::geteuid() } {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
pub async fn call(directory: &Path, request: &Request) -> Result<Response> {
    let directory = private_directory(directory)?;
    let path = directory.join("control.sock");
    check_socket(&path)?;
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let mut socket = UnixStream::connect(path).await?;
        peer(&socket)?;
        write(&mut socket, request, MAX_REQUEST).await?;
        let response: Response = read(&mut socket, MAX_RESPONSE).await?;
        if let Response::Status { status } = &response {
            if status.version != VERSION {
                return Err(Error::Protocol);
            }
        }
        Ok(response)
    })
    .await
    .map_err(|_| Error::Timeout)?
}
fn check_socket(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Error::Offline)?;
    if !metadata.file_type().is_socket()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(Error::Storage);
    }
    Ok(())
}
struct SocketCleanup(PathBuf);
impl Drop for SocketCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub async fn serve(directory: &Path, runtime: Arc<Runtime>) -> Result<()> {
    let directory = private_directory(directory)?;
    // A separate runtime lock protects stale socket removal and cleanup. The
    // persistent store lock independently excludes two authorization writers.
    let _lock = Store::open(&directory)?;
    let path = directory.join("control.sock");
    if fs::symlink_metadata(&path).is_ok() {
        check_socket(&path)?;
        fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(&path)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    let _cleanup = SocketCleanup(path);
    let slots = Arc::new(Semaphore::new(8));
    let mut tasks = JoinSet::new();
    let mut stopped = runtime.shutdown_signal();
    loop {
        if *stopped.borrow() {
            break;
        }
        tokio::select! {
            _ = stopped.changed() => break,
            accepted = listener.accept() => {
                let (mut socket, _) = accepted?;
                if peer(&socket).is_err() { continue; }
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue; };
                let runtime = runtime.clone();
                tasks.spawn(async move {
                    let _slot = slot;
                    let request = tokio::time::timeout(std::time::Duration::from_secs(10), read::<Request>(&mut socket, MAX_REQUEST)).await;
                    let Ok(Ok(request)) = request else { return; };
                    // Credential store dialogs may outlive the client deadline.
                    // Never cancel/replay a possibly persisted Configure/Decide.
                    let stopping = matches!(&request, Request::Stop);
                    let response = dispatch(&runtime, request).await.unwrap_or_else(|error| Response::Error { message: error.to_string() });
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), write(&mut socket, &response, MAX_RESPONSE)).await;
                    if stopping { runtime.stop().await; }
                });
            },
            _ = tasks.join_next(), if !tasks.is_empty() => {},
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}
async fn dispatch(runtime: &Runtime, request: Request) -> Result<Response> {
    match request {
        Request::Status => {
            return Ok(Response::Status {
                status: runtime.status().await,
            })
        }
        Request::Configure {
            relay_url,
            name,
            token,
        } => runtime.configure(relay_url, name, token).await?,
        Request::InviteAutomatic => {
            return Ok(Response::Invitation {
                invitation: runtime.invite_automatic().await?,
            })
        }
        Request::Invite => {
            return Ok(Response::Invitation {
                invitation: runtime.invite().await?,
            })
        }
        Request::Decide {
            invitation_id,
            candidate,
            approve,
        } => {
            runtime
                .decide(
                    &invitation_id,
                    &candidate.request_id,
                    &candidate.public_key,
                    approve,
                )
                .await?
        }
        Request::CloseInvitation { invitation_id } => {
            runtime.close_invitation(&invitation_id).await
        }
        Request::Revoke { public_key } => runtime.revoke(&public_key).await?,
        Request::Stop => {} // Flush acknowledgement first, then terminate IPC.
    }
    Ok(Response::Ok)
}
