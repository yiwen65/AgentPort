use agentport_remote_bridge::serve;
use agentport_service::CoreService;
use std::io::{stderr, stdin, stdout, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() != ["serve", "--stdio"] {
        let _ = writeln!(stderr(), "usage: agentport-remote-bridge serve --stdio");
        std::process::exit(2);
    }

    let service = match CoreService::open_default() {
        Ok(service) => service,
        Err(_) => {
            let _ = writeln!(stderr(), "agentport remote bridge: service startup failed");
            std::process::exit(1);
        }
    };
    // `serve` moves exclusive stdout ownership to its bounded writer thread;
    // `StdoutLock` is not Send, while `Stdout` itself is.
    let mut output = stdout();
    let result = serve(
        &mut stdin().lock(),
        &mut output,
        &mut stderr().lock(),
        &service,
    );
    if let Err(error) = result {
        let _ = writeln!(stderr(), "agentport remote bridge: {error}");
        std::process::exit(1);
    }
}
