//! Explicit background Relay control; no GUI-lifetime ownership or login item.
use agentport_relay::connector::{ipc, Status};
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::State;

#[derive(Default)]
pub struct DesktopRelay(pub tokio::sync::Mutex<()>);
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
    let _start = relay.0.lock().await;
    let (binary, socket) = locations(state.paths.root())?;
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
        .arg(state.paths.root())
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
) -> Result<ipc::Response, String> {
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
