use agentport_relay::{
    server::{serve, Config},
    Error, Result,
};
use std::{
    fs,
    io::Read,
    net::SocketAddr,
    path::{Path, PathBuf},
};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("AgentPort Relay: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut bind: SocketAddr = "127.0.0.1:8787".parse().expect("static address");
    let mut token_file: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--bind" => {
                bind = args
                    .next()
                    .ok_or(Error::Invalid("missing bind address"))?
                    .parse()
                    .map_err(|_| Error::Invalid("bind address"))?;
            }
            "--host-token-file" => {
                token_file = Some(
                    args.next()
                        .ok_or(Error::Invalid("missing token file"))?
                        .into(),
                );
            }
            "--help" => {
                println!("agentport-relay [--bind 127.0.0.1:8787] --host-token-file PATH\nUse TLS termination for public deployments; clients require wss outside literal loopback.\nThe host token file must be private (0600); its contents are never printed.");
                return Ok(());
            }
            _ => return Err(Error::Invalid("unknown argument; see --help")),
        }
    }
    let path = token_file.ok_or(Error::Invalid("--host-token-file is required"))?;
    let token = read_token(&path)?;
    let config = Config::new(token.trim())?;
    drop(token);
    let listener = TcpListener::bind(bind).await?;
    println!(
        "AgentPort Relay listening on {} (TLS terminates upstream)",
        listener.local_addr()?
    );
    serve(listener, config, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await
}

fn read_token(path: &Path) -> Result<Zeroizing<String>> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Inspect the opened descriptor, not a separate path lookup. Nonblocking
        // avoids hanging on an accidentally supplied FIFO before type checking.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > 1024 {
        return Err(Error::Invalid("host token file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
        {
            return Err(Error::Invalid(
                "host token file must be owned, private and single-link",
            ));
        }
    }
    let mut token = Zeroizing::new(String::new());
    file.take(1025).read_to_string(&mut token)?;
    if token.len() > 1024 {
        return Err(Error::Invalid("host token file length"));
    }
    Ok(token)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn token_file_is_bounded_private_regular_owned_and_not_linked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        fs::write(&path, "isolated-test-token").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_token(&path).unwrap().as_str(), "isolated-test-token");
        let link = dir.path().join("symlink");
        symlink(&path, &link).unwrap();
        assert!(read_token(&link).is_err());
        let hard = dir.path().join("hardlink");
        fs::hard_link(&path, &hard).unwrap();
        assert!(read_token(&path).is_err());
        fs::remove_file(&hard).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(read_token(&path).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&path, vec![b'x'; 1025]).unwrap();
        assert!(read_token(&path).is_err());
        assert!(read_token(dir.path()).is_err());
    }
}
