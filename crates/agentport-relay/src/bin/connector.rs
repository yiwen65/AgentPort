#[cfg(unix)]
fn read_private_apns_key(
    path: &std::path::Path,
) -> agentport_relay::Result<zeroize::Zeroizing<String>> {
    use agentport_relay::Error;
    use std::{
        fs::OpenOptions,
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    use zeroize::Zeroizing;
    if !path.is_absolute() {
        return Err(Error::Invalid("APNs key path must be absolute"));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| Error::Credential)?;
    let meta = file.metadata().map_err(|_| Error::Credential)?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o777 != 0o600
        || meta.nlink() != 1
        || meta.len() == 0
        || meta.len() > 8192
    {
        return Err(Error::Credential);
    }
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Credential)?;
    if bytes.is_empty() || bytes.len() > 8192 {
        return Err(Error::Credential);
    }
    Ok(Zeroizing::new(
        String::from_utf8(bytes.to_vec()).map_err(|_| Error::Credential)?,
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::read_private_apns_key;
    use std::{
        fs,
        os::unix::fs::{symlink, PermissionsExt},
    };
    #[test]
    fn key_import_rejects_symlinks_and_unsafe_permissions() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("AuthKey.p8");
        fs::write(&file, "private fixture").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            read_private_apns_key(&file).unwrap().as_str(),
            "private fixture"
        );
        let link = temp.path().join("linked.p8");
        symlink(&file, &link).unwrap();
        assert!(read_private_apns_key(&link).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_private_apns_key(&file).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&file, "x".repeat(8193)).unwrap();
        assert!(read_private_apns_key(&file).is_err());
        assert!(read_private_apns_key(std::path::Path::new("relative.p8")).is_err());
    }
}

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
async fn start_push_worker(
    runtime: std::sync::Arc<agentport_relay::connector::Runtime>,
    data: std::path::PathBuf,
    state: std::path::PathBuf,
) -> Option<tokio::task::JoinHandle<agentport_relay::Result<()>>> {
    use agentport_relay::{
        connector::{apns, push_worker},
        endpoint::PushEnvironment,
    };
    use std::sync::Arc;
    let config = match runtime.apns_credentials().await {
        Ok(Some(config)) => config,
        Ok(None) => return None,
        Err(_) => {
            eprintln!("AgentPort Connector: APNs credentials unavailable; push alerts disabled");
            return None;
        }
    };
    let peer = runtime.status().await.peer?;
    let environment = match config.environment {
        PushEnvironment::Sandbox => apns::Environment::Sandbox,
        PushEnvironment::Production => apns::Environment::Production,
    };
    let sender = match apns::ApnsSender::new(
        &config.key_p8_pem,
        &config.key_id,
        &config.team_id,
        &config.topic,
        environment,
    ) {
        Ok(sender) => sender,
        Err(_) => {
            eprintln!("AgentPort Connector: APNs signing configuration unavailable");
            return None;
        }
    };
    let paths = agentport_core::paths::AppPaths::new(data);
    let db = match tokio::task::spawn_blocking(move || agentport_core::db::Db::open(&paths)).await {
        Ok(Ok(db)) => db,
        _ => {
            eprintln!("AgentPort Connector: APNs attention database unavailable");
            return None;
        }
    };
    runtime.set_apns_delivery_active(true).await;
    Some(tokio::spawn(async move {
        let result = push_worker::run(
            runtime.clone(),
            Arc::new(sender),
            Arc::new(db),
            state,
            peer.host_id,
            config.environment,
            runtime.shutdown_signal(),
        )
        .await;
        runtime.set_apns_delivery_active(false).await;
        if result.is_err() {
            eprintln!("AgentPort Connector: APNs delivery worker stopped; restart connector after resolving configuration or storage");
        }
        result
    }))
}

#[cfg(unix)]
async fn run() -> agentport_relay::Result<()> {
    use agentport_relay::{
        connector::{ipc, Keychain, Runtime, Store},
        endpoint::PushEnvironment,
        Error,
    };
    use std::{path::PathBuf, sync::Arc};
    let mut args = std::env::args().skip(1);
    let mut data = None;
    let mut key_file = None;
    let mut key_id = None;
    let mut team_id = None;
    let mut topic = None;
    let mut environment = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => {
                data = Some(PathBuf::from(
                    args.next()
                        .ok_or(Error::Invalid("missing data directory"))?,
                ))
            }
            "--configure-apns-key-file" => {
                key_file = Some(PathBuf::from(
                    args.next().ok_or(Error::Invalid("missing APNs key file"))?,
                ))
            }
            "--key-id" => key_id = Some(args.next().ok_or(Error::Invalid("missing APNs key ID"))?),
            "--team-id" => {
                team_id = Some(args.next().ok_or(Error::Invalid("missing APNs Team ID"))?)
            }
            "--topic" => topic = Some(args.next().ok_or(Error::Invalid("missing APNs topic"))?),
            "--environment" => {
                environment = Some(match args.next().as_deref() {
                    Some("sandbox") => PushEnvironment::Sandbox,
                    Some("production") => PushEnvironment::Production,
                    _ => {
                        return Err(Error::Invalid(
                            "APNs environment must be sandbox or production",
                        ))
                    }
                })
            }
            "--help" => {
                println!("agentport-connector --data-dir ABSOLUTE_PATH\nIndependent outbound Relay connector; GUI controls it over private same-user Unix IPC.\nNo login item or autostart is installed. Bridge must be bundled beside this executable.\nTo securely import personal APNs credentials into the running connector:\nagentport-connector --data-dir ABS --configure-apns-key-file ABS --key-id X --team-id Y --topic com.agentport.mobile --environment sandbox|production");
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
    if key_file.is_some()
        || key_id.is_some()
        || team_id.is_some()
        || topic.is_some()
        || environment.is_some()
    {
        let file = key_file.ok_or(Error::Invalid("all APNs options are required"))?;
        let key_id = key_id.ok_or(Error::Invalid("all APNs options are required"))?;
        let team_id = team_id.ok_or(Error::Invalid("all APNs options are required"))?;
        let topic = topic.ok_or(Error::Invalid("all APNs options are required"))?;
        let environment = environment.ok_or(Error::Invalid("all APNs options are required"))?;
        let key_p8_pem = read_private_apns_key(&file)?;
        return match ipc::call(
            &socket,
            &ipc::Request::ConfigureApns {
                key_p8_pem,
                key_id,
                team_id,
                topic,
                environment,
            },
        )
        .await?
        {
            ipc::Response::Ok => {
                println!("APNs credentials imported. Restart this installation's connector to activate them; Session Hosts remain independent.");
                Ok(())
            }
            ipc::Response::Error { .. } => {
                Err(Error::Invalid("APNs configuration rejected by connector"))
            }
            _ => Err(Error::Protocol),
        };
    }
    let host_sockets = std::env::var_os("AGENTPORT_SOCKET_DIR").map(PathBuf::from);
    let runtime = Runtime::open(
        Store::open(&state)?,
        Arc::new(Keychain),
        bin.join("agentport-remote-bridge"),
        data.clone(),
        host_sockets,
    )
    .await?;
    // Optional private provider. An absent/missing signing key must not stop
    // the authenticated Relay channel; import/replacement takes effect after
    // restarting this connector (without touching independent Session Hosts).
    let push = start_push_worker(runtime.clone(), data, state.clone()).await;
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
    if let Some(worker) = push {
        if worker.await.is_err() {
            eprintln!("AgentPort Connector: APNs delivery worker panicked; push alerts disabled");
        }
    }
    result
}
