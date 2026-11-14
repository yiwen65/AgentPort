use agentport_core::paths::AppPaths;
use agentport_remote_bridge::{adapter_cache, serve};
use agentport_service::CoreService;
use std::io::{stderr, stdin, stdout, Write};
use std::sync::Arc;

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
    let refresh_root = paths.root().to_path_buf();
    let service = match CoreService::open(paths) {
        Ok(service) => Arc::new(service),
        Err(_) => {
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
    if let Err(error) = result {
        let _ = writeln!(stderr(), "agentport remote bridge: {error}");
        std::process::exit(1);
    }
}
