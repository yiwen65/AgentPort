//! `agentport-mcp serve --stdio`: the process an MCP host spawns.
//!
//! stdout carries protocol bytes only; every diagnostic goes to stderr, because
//! a stray `println!` would corrupt a JSON-RPC stream.

use agentport_core::paths::AppPaths;
use agentport_mcp::protocol::{parse_line, read_message, write_message, RpcError};
use agentport_mcp::server::Server;
use agentport_mcp::tools::{Toolbox, ToolboxConfig};
use agentport_mcp::SERVER_VERSION;
use agentport_service::CoreService;
use std::io::{stderr, stdin, stdout, BufReader, Write};
use std::path::PathBuf;
use std::sync::Arc;

/// How many delegations deep an MCP-created chain may go: 2 means a Session
/// created by the user's Agent may delegate once more, and that grandchild may
/// not delegate again.
const DEFAULT_MAX_DEPTH: u32 = 2;
/// Live Sessions one server instance drives at a time.
const DEFAULT_MAX_SESSIONS: usize = 8;

fn env_u32(name: &str, default: u32) -> u32 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(default)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        let _ = writeln!(stdout(), "agentport-mcp {SERVER_VERSION}");
        return;
    }
    if args != ["serve", "--stdio"] {
        let _ = writeln!(stderr(), "usage: agentport-mcp serve --stdio");
        std::process::exit(2);
    }

    let paths: AppPaths = match AppPaths::discover() {
        Ok(paths) => paths,
        Err(error) => {
            let _ = writeln!(stderr(), "agentport-mcp: cannot locate the data directory: {error}");
            std::process::exit(1);
        }
    };
    // A second writer can hold the migration lock for a moment at startup
    // (the GUI or another MCP instance); retry instead of dying.
    let mut last_error = None;
    let mut service = None;
    for attempt in 0..4 {
        match CoreService::open(paths.clone()) {
            Ok(opened) => {
                service = Some(Arc::new(opened));
                break;
            }
            Err(error) => {
                last_error = Some(format!("{error:?}"));
                if attempt < 3 {
                    std::thread::sleep(std::time::Duration::from_millis(250));
                }
            }
        }
    }
    let Some(service) = service else {
        let _ = writeln!(
            stderr(),
            "agentport-mcp: service startup failed: {}",
            last_error.unwrap_or_default()
        );
        std::process::exit(1);
    };

    let toolbox = Toolbox::new(
        service,
        ToolboxConfig {
            root: paths.root().to_path_buf(),
            parent_session_id: std::env::var("AGENTPORT_SESSION_ID")
                .ok()
                .filter(|value| !value.is_empty()),
            max_depth: env_u32("AGENTPORT_MCP_MAX_DEPTH", DEFAULT_MAX_DEPTH),
            max_sessions: env_usize("AGENTPORT_MCP_MAX_SESSIONS", DEFAULT_MAX_SESSIONS),
        },
    );
    let depth = toolbox.depth();
    let mut server = Server::new(toolbox, SERVER_VERSION);

    let mut input = BufReader::new(stdin());
    let mut output = stdout();
    loop {
        match read_message(&mut input) {
            Ok(Some(line)) => match server.handle_line(&line) {
                Some(response) => {
                    if let Err(error) = write_message(&mut output, &response) {
                        let _ = writeln!(stderr(), "agentport-mcp: stdout write failed: {error}");
                        std::process::exit(1);
                    }
                }
                None => {}
            },
            Ok(None) => break,
            Err(RpcError { code, message, .. }) => {
                // Transport-level failures still get a JSON-RPC error so the
                // host reports a protocol error instead of a silent hang. A
                // framed message line is recoverable; a read error is not.
                let response = agentport_mcp::protocol::failure(
                    &serde_json::Value::Null,
                    RpcError::new(code, message.clone()),
                );
                if write_message(&mut output, &response).is_err() {
                    std::process::exit(1);
                }
                if code == agentport_mcp::protocol::INTERNAL_ERROR {
                    let _ = writeln!(stderr(), "agentport-mcp: stdin failed: {message}");
                    std::process::exit(1);
                }
            }
        }
    }
    let _ = writeln!(stderr(), "agentport-mcp: stdin closed (depth {depth})");
}

/// Keep `parse_line` reachable for the binary's own smoke check.
#[allow(dead_code)]
fn self_check(line: &str) -> bool {
    parse_line(line).is_ok()
}

/// Unused today, kept so a future `--print-config` subcommand has a root type.
#[allow(dead_code)]
type RootPath = PathBuf;
