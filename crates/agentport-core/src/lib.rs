//! AgentPort core library.
//!
//! Layering (PRD ch.6): the GUI never owns agent processes. This library owns
//! metadata (SQLite), adapter probing, worktree safety, redaction, secrets and
//! the host manager; `agentport-host` owns PTY/process-group/log per session.

pub mod adapters;
pub mod backup;
pub mod db;
pub mod diag;
pub mod error;
pub mod export;
pub mod git;
pub mod history;
pub mod host_manager;
pub mod ids;
pub mod legacy_logs;
pub mod logs;
pub mod manifest;
pub mod models;
pub mod native_backup;
pub mod native_cleanup;
pub mod notify;
pub mod notification_policy;
pub mod notification_setup;
pub mod paths;
pub mod pi_storage;
pub mod protocol;
pub mod redact;
pub mod search;
pub mod secrets;
pub mod state;
pub mod screen_detection;
pub mod timeline;

pub use error::{CoreError, Result};

pub mod terminal_seed;
