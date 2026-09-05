//! Untrusted WebSocket relay and authenticated end-to-end Noise channels.
//! No Session command is exposed to the relay server.
#[cfg(all(feature = "connector", unix))]
pub mod connector;
pub mod crypto;
pub mod endpoint;
pub mod net;
pub mod protocol;
#[cfg(feature = "server")]
pub mod server;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Invalid relay configuration or message: {0}")]
    Invalid(&'static str),
    #[error("Relay peer authentication failed")]
    Unauthorized,
    #[error("Relay protocol or encrypted message is invalid")]
    Protocol,
    #[error("Relay connection interrupted or unavailable")]
    Transport,
    #[error("Relay operation timed out")]
    Timeout,
    #[error("The computer is not connected to the relay")]
    Offline,
    #[error("Relay capacity is busy; try again later")]
    Busy,
    #[error("Relay secure credential storage is unavailable; no plaintext fallback")]
    Credential,
    #[error("Relay local state could not be safely read or persisted")]
    Storage,
}
impl From<snow::Error> for Error {
    fn from(_: snow::Error) -> Self {
        Self::Unauthorized
    }
}
impl From<std::io::Error> for Error {
    fn from(_: std::io::Error) -> Self {
        Self::Transport
    }
}
impl From<tokio_tungstenite::tungstenite::Error> for Error {
    fn from(_: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::Transport
    }
}
impl From<serde_json::Error> for Error {
    fn from(_: serde_json::Error) -> Self {
        Self::Protocol
    }
}
