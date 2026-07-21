//! Error types shared across the workspace.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("validation: {0}")]
    Validation(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("git: {0}")]
    Git(String),
    #[error("host: {0}")]
    Host(String),
    #[error("adapter: {0}")]
    Adapter(String),
    #[error("secret store unavailable: {0}")]
    SecretStoreUnavailable(String),
    #[error("secret store: {0}")]
    SecretStore(String),
    #[error("redaction failed: {0}")]
    Redaction(String),
    #[error("export failed: {0}")]
    Export(String),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("timeout: {0}")]
    Timeout(String),
    #[error("blocked: {0}")]
    Blocked(String),
    #[error("internal: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, CoreError>;
