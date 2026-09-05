#[cfg(unix)]
#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("AgentPort Connector: {error}");
        std::process::exit(1);
    }
}
#[cfg(not(unix))]
fn main() {
    eprintln!("AgentPort Connector currently requires Unix local IPC");
    std::process::exit(1);
}

#[cfg(unix)]
async fn run() -> agentport_relay::Result<()> {
    use agentport_relay::{
        connector::{ipc, Keychain, Runtime, Store},
        Error,
    };
    use std::{path::PathBuf, sync::Arc};
    let mut args = std::env::args().skip(1);
    let mut data = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => {
                data = Some(PathBuf::from(
                    args.next()
                        .ok_or(Error::Invalid("missing data directory"))?,
                ))
            }
            "--help" => {
                println!("agentport-connector --data-dir ABSOLUTE_PATH\nIndependent outbound Relay connector; GUI controls it over private same-user Unix IPC.\nNo login item or autostart is installed. Bridge must be bundled beside this executable.");
                return Ok(());
            }
            _ => return Err(Error::Invalid("unknown connector argument")),
        }
    }
    let data = data
        .ok_or(Error::Invalid("--data-dir is required"))?
        .canonicalize()?;
    let exe = std::env::current_exe()?.canonicalize()?;
    let bin = exe
        .parent()
        .ok_or(Error::Invalid("connector installation path"))?;
    let namespace = ipc::namespace(bin, &data)?;
    let state = ipc::state_directory(&data, &namespace)?;
    let socket = ipc::socket_directory(&namespace)?;
    let host_sockets = std::env::var_os("AGENTPORT_SOCKET_DIR").map(PathBuf::from);
    let runtime = Runtime::open(
        Store::open(&state)?,
        Arc::new(Keychain),
        bin.join("agentport-remote-bridge"),
        data,
        host_sockets,
    )
    .await?;
    let registration = tokio::spawn(runtime.clone().run());
    let result = tokio::select! {
        result = ipc::serve(&socket, runtime.clone()) => result,
        _ = tokio::signal::ctrl_c() => Ok(()),
        _ = async {
            if let Ok(mut term) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) { term.recv().await; }
            else { std::future::pending::<()>().await; }
        } => Ok(()),
    };
    runtime.stop().await;
    let _ = registration.await;
    result
}
