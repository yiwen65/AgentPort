use agentport_core::paths::AppPaths;
use agentport_remote_bridge::{adapter_cache, serve};
use agentport_service::CoreService;
use std::io::{stderr, stdin, stdout, Write};
use std::path::Path;
use std::sync::Arc;

fn bridge_log_path(paths: &AppPaths) -> std::path::PathBuf {
    paths.root().join("logs").join("remote-bridge.log")
}

fn append_bridge_log(path: &Path, line: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let _ = writeln!(file, "{stamp} pid={} {line}", std::process::id());
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() != ["serve", "--stdio"] {
        let _ = writeln!(stderr(), "usage: agentport-remote-bridge serve --stdio");
        std::process::exit(2);
    }

    let paths = match AppPaths::discover() {
        Ok(paths) => paths,
        Err(_) => {
            let _ = writeln!(stderr(), "agentport remote bridge: service startup failed");
            std::process::exit(1);
        }
    };
    let log_path = bridge_log_path(&paths);
    if cfg!(debug_assertions) {
        append_bridge_log(&log_path, "start");
        let panic_path = log_path.clone();
        std::panic::set_hook(Box::new(move |info| {
            append_bridge_log(&panic_path, &format!("panic: {info}"));
        }));
    }
    let refresh_root = paths.root().to_path_buf();
    let service = match CoreService::open(paths) {
        Ok(service) => Arc::new(service),
        Err(_) => {
            if cfg!(debug_assertions) {
                append_bridge_log(&log_path, "service startup failed");
            }
            let _ = writeln!(stderr(), "agentport remote bridge: service startup failed");
            std::process::exit(1);
        }
    };
    // Adapter discovery runs off the request thread and only updates the Host
    // DB; desktop reads stay cheap and terminal input is never queued behind a
    // multi-second probe.
    adapter_cache::spawn(Arc::clone(&service), refresh_root);
    // `serve` moves exclusive stdout ownership to its bounded writer thread;
    // `StdoutLock` is not Send, while `Stdout` itself is.
    let mut output = stdout();
    let result = serve(
        &mut stdin().lock(),
        &mut output,
        &mut stderr().lock(),
        service.as_ref(),
    );
    if cfg!(debug_assertions) {
        match &result {
            Ok(reason) => append_bridge_log(&log_path, &format!("serve closed: {reason:?}")),
            Err(error) => append_bridge_log(&log_path, &format!("serve error: {error}")),
        }
    }
    if let Err(error) = result {
        let _ = writeln!(stderr(), "agentport remote bridge: {error}");
        std::process::exit(1);
    }
}
