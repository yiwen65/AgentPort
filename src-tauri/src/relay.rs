//! App-launch background Relay startup and explicit control; no login item.
use agentport_relay::connector::{ipc, Status};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::{Manager, State};

#[derive(Default)]
struct LaunchState {
    startup_handled: bool,
}
impl LaunchState {
    fn claim_startup(&mut self) -> bool {
        !std::mem::replace(&mut self.startup_handled, true)
    }
}

#[derive(Default)]
pub struct DesktopRelay(tokio::sync::Mutex<LaunchState>);

/// Called once by Tauri setup, never by frontend refreshes or window events.
/// Sharing the manual-start lock also orders an early Stop before this task.
pub fn start_on_app_launch(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let relay = app.state::<DesktopRelay>();
        let mut launch = relay.0.lock().await;
        if !launch.claim_startup() {
            return;
        }
        let state = app.state::<crate::AppState>();
        if let Err(error) = start_or_reuse(state.paths.root()).await {
            tracing::warn!(%error, "Relay connector app-launch startup failed");
        }
    });
}
fn locations(data: &std::path::Path) -> Result<(PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|_| "Cannot locate AgentPort")?;
    let bin = exe.parent().ok_or("Cannot locate AgentPort installation")?;
    let namespace = ipc::namespace(bin, data).map_err(|e| e.to_string())?;
    let socket = ipc::socket_directory(&namespace).map_err(|e| e.to_string())?;
    Ok((bin.join("agentport-connector"), socket))
}
#[tauri::command]
pub async fn desktop_relay_status(
    state: State<'_, crate::AppState>,
) -> Result<Option<Status>, String> {
    let (_, socket) = locations(state.paths.root())?;
    match ipc::call(&socket, &ipc::Request::Status).await {
        Ok(ipc::Response::Status { status }) => Ok(Some(status)),
        Err(agentport_relay::Error::Offline | agentport_relay::Error::Transport) => Ok(None),
        Ok(ipc::Response::Error { message }) => Err(message),
        Err(error) => Err(error.to_string()),
        _ => Err("Unexpected Relay connector response".into()),
    }
}
#[tauri::command]
pub async fn desktop_relay_start(
    state: State<'_, crate::AppState>,
    relay: State<'_, DesktopRelay>,
) -> Result<Status, String> {
    let mut launch = relay.0.lock().await;
    launch.claim_startup();
    start_or_reuse(state.paths.root()).await
}

async fn start_or_reuse(data: &std::path::Path) -> Result<Status, String> {
    let (binary, socket) = locations(data)?;
    start_or_reuse_at(data, &binary, &socket).await
}

async fn start_or_reuse_at(
    data: &std::path::Path,
    binary: &std::path::Path,
    socket: &std::path::Path,
) -> Result<Status, String> {
    match ipc::call(&socket, &ipc::Request::Status).await {
        Ok(ipc::Response::Status { status }) => return Ok(status),
        Err(agentport_relay::Error::Offline | agentport_relay::Error::Transport) => {}
        Err(error) => return Err(error.to_string()),
        _ => return Err("Unexpected Relay connector response".into()),
    }
    if !binary.is_file() {
        return Err("Relay connector is missing; rebuild or reinstall this app".into());
    }
    let mut command = Command::new(binary);
    command
        .arg("--data-dir")
        .arg(data)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A new POSIX session avoids GUI/process-group exit taking the connector
        // with it. No shell invocation or terminal input is involved.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start Relay connector")?;
    // A plain detached reaper thread must not hold the GUI async runtime open.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if let Ok(ipc::Response::Status { status }) =
                ipc::call(&socket, &ipc::Request::Status).await
            {
                return status;
            }
        }
    })
    .await
    .map_err(|_| {
        "Relay connector did not become ready; check the installation and private state permissions"
            .into()
    })
}
#[tauri::command]
pub async fn desktop_relay_control(
    state: State<'_, crate::AppState>,
    request: ipc::Request,
    relay: State<'_, DesktopRelay>,
) -> Result<ipc::Response, String> {
    // Stop must wait for an in-flight startup, or suppress one not yet polled.
    // Even an uncertain Stop is never followed by an automatic retry.
    let _stop = if matches!(&request, ipc::Request::Stop) {
        let mut launch = relay.0.lock().await;
        launch.claim_startup();
        Some(launch)
    } else {
        None
    };
    let (_, socket) = locations(state.paths.root())?;
    // Never replay an uncertain configuration/approval/revocation. The UI must
    // refresh authoritative status before offering another explicit attempt.
    match ipc::call(&socket, &request)
        .await
        .map_err(|error| error.to_string())?
    {
        ipc::Response::Error { message } => Err(message),
        response => Ok(response),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn private_temp() -> tempfile::TempDir {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn startup_is_once_per_launch_including_after_manual_control() {
        let mut launch = LaunchState::default();
        assert!(launch.claim_startup());
        assert!(!launch.claim_startup());
        // Manual Start/Stop uses the same claim before a pending startup runs.
        let mut manual_first = LaunchState::default();
        manual_first.claim_startup();
        assert!(!manual_first.claim_startup());
        assert!(LaunchState::default().claim_startup());
    }

    #[tokio::test]
    async fn existing_connector_is_reused_without_a_binary() {
        // Short temporary path also fits Darwin's Unix socket path limit.
        let dir = private_temp();
        let listener = tokio::net::UnixListener::bind(dir.path().join("control.sock")).unwrap();
        std::fs::set_permissions(dir.path().join("control.sock"), std::fs::Permissions::from_mode(0o600)).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let length = stream.read_u32().await.unwrap();
            let mut bytes = vec![0; length as usize];
            stream.read_exact(&mut bytes).await.unwrap();
            assert!(matches!(
                serde_json::from_slice::<ipc::Request>(&bytes).unwrap(),
                ipc::Request::Status
            ));
            let response = ipc::Response::Status {
                status: Status {
                    version: 1,
                    phase: agentport_relay::connector::Phase::Unconfigured,
                    peer: None,
                    devices: vec![],
                    pairing: None,
                    active_channels: 0,
                },
            };
            let bytes = serde_json::to_vec(&response).unwrap();
            stream.write_u32(bytes.len() as u32).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
        });
        let status = start_or_reuse_at(dir.path(), &dir.path().join("missing"), dir.path())
            .await
            .unwrap();
        assert!(matches!(
            status.phase,
            agentport_relay::connector::Phase::Unconfigured
        ));
        assert!(status.pairing.is_none());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn missing_connector_returns_recoverable_error() {
        let dir = private_temp();
        let error = start_or_reuse_at(dir.path(), &dir.path().join("missing"), dir.path())
            .await
            .unwrap_err();
        assert!(error.contains("missing; rebuild or reinstall"));
    }
}
