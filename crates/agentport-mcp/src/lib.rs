//! AgentPort Sessions MCP server.
//!
//! A stdio Model Context Protocol server that drives real AgentPort Sessions:
//! it creates them through `agentport-service`, so the Host process, process
//! group, status evidence and native resume behaviour are identical to the
//! desktop app's own Sessions.

pub mod ops;
pub mod protocol;
pub mod registry;
pub mod server;
pub mod text;
pub mod tools;
pub mod ui;

/// Version reported in `serverInfo`; kept in step with the workspace.
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
