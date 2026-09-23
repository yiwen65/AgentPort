//! Desktop client for remote AgentPort devices (multi-device switching).
//!
//! Speaks the AgentPort remote protocol (agentport-remote-protocol) over
//! pluggable transports — SSH exec channels and end-to-end relay sessions —
//! and keeps one explicit connection lifecycle per device in
//! `RemoteConnectionManager`. Tauri commands live in `commands`; every other
//! module is AppHandle-free.

pub mod attention_notify;
pub mod commands;
mod connection;
pub mod credentials;
#[cfg(test)]
mod e2e_linux;
mod identity;
#[cfg(test)]
mod integration_tests;
mod manager;
mod pairing;
pub mod registry;
mod relay;
mod ssh;
mod tofu;
mod transport;
mod types;

pub use manager::RemoteConnectionManager;
pub use registry::{DeviceAddSshDraft, DeviceRegistry};
pub use types::DeviceProfile;

use agentport_remote_protocol::{ProtocolVersion, RunCursor};
use serde::Serialize;

/// Structured command error: the frontend branches on `code`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCommandError {
    pub code: String,
    pub message: String,
}

impl RemoteCommandError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for RemoteCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RemoteCommandError {}

/// Summary of a negotiated connection, returned by `remote_connect`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHello {
    pub protocol_version: ProtocolVersion,
    pub capabilities: Vec<String>,
    pub device_name: String,
    pub server_agentport_version: String,
    pub server_platform: String,
}

impl RemoteHello {
    fn from_hello_result(
        result: &agentport_remote_protocol::HelloResult,
        device_name: String,
    ) -> Self {
        Self {
            protocol_version: result.protocol,
            capabilities: result
                .capabilities
                .iter()
                .filter(|capability| capability.enabled)
                .map(|capability| capability.name.clone())
                .collect(),
            device_name,
            server_agentport_version: result.server.agentport_version.clone(),
            server_platform: result.server.platform.clone(),
        }
    }
}

/// One event pushed to the frontend over `remote_subscribe`'s Channel.
/// Connection-scoped control events (e.g. `transport_closed`) have an empty
/// `subscriptionId` and no cursor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEventMsg {
    pub subscription_id: String,
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<RunCursor>,
    pub payload: serde_json::Value,
}
