//! Durable, per-registration delivery of content-free Session attention alerts.
//! `state_dir` is the connector's exclusive, 0700 state directory (not the DB dir).
//! A cursor is committed only after APNs accepts a send; a crash may duplicate an
//! alert, but cannot silently acknowledge an unsent one.

use super::{apns, private_directory, PushTarget, Runtime};
use crate::{endpoint::PushEnvironment, protocol::identifier, Error, Result};
use agentport_core::{db::Db, models::AttentionCursor};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::watch, time::Instant};

const FILE_NAME: &str = "push-cursors.json";
const MAX_STATE: u64 = 64 * 1024;
const PAGE: u16 = 32;
const POLL_INTERVAL: Duration = Duration::from_secs(3);
const MAX_BACKOFF: Duration = Duration::from_secs(60);

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorState {
    // Keys are SHA-256 digests of the approved phone identity + registration.
    // Never persist the APNs token itself a second time.
    registrations: HashMap<String, DeliveryState>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeliveryState {
    cursor: AttentionCursor,
    disabled: bool,
}

struct Retry {
    until: Instant,
    delay: Duration,
}

#[derive(Debug, PartialEq, Eq)]
enum DeliveryDecision {
    Advanced,
    Disabled,
    Retry,
    Stop,
}

/// Only APNs acceptance advances a durable cursor; transient and provider
/// configuration failures leave the same event available for later retry.
fn apply_outcome(
    state: &mut DeliveryState,
    cursor: AttentionCursor,
    result: std::result::Result<(), apns::PushError>,
) -> DeliveryDecision {
    match result {
        Ok(()) => {
            state.cursor = cursor;
            DeliveryDecision::Advanced
        }
        Err(apns::PushError::Revoked | apns::PushError::InvalidToken) => {
            state.disabled = true;
            DeliveryDecision::Disabled
        }
        Err(apns::PushError::Transient { .. }) => DeliveryDecision::Retry,
        Err(
            apns::PushError::InvalidConfig
            | apns::PushError::InvalidIdentifier
            | apns::PushError::Permanent { .. },
        ) => DeliveryDecision::Stop,
    }
}

fn registration_key(target: &PushTarget) -> String {
    let mut hash = Sha256::new();
    hash.update(target.public_key.as_bytes());
    hash.update([0]);
    hash.update(target.registration.token.as_bytes());
    hash.update([0]);
    hash.update(match target.registration.environment {
        PushEnvironment::Sandbox => b"sandbox".as_slice(),
        PushEnvironment::Production => b"production".as_slice(),
    });
    // Revocation followed by a new approval may reuse the same identity/token.
    // Its new registration epoch must not inherit the revoked delivery cursor.
    hash.update(target.registered_at_ms.unwrap_or_default().to_be_bytes());
    format!("{:x}", hash.finalize())
}

/// Start at the Connector's durable registration timestamp, not worker
/// observation time: restart/reconfiguration must not skip intervening events.
/// Legacy registrations without a timestamp predate this provider and start now.
fn initial_cursor(registered_at_ms: Option<i64>) -> AttentionCursor {
    AttentionCursor {
        occurred_at: registered_at_ms
            .and_then(chrono::DateTime::<Utc>::from_timestamp_millis)
            .unwrap_or_else(Utc::now),
        session_id: String::new(),
        run_ordinal: 0,
        sequence: 0,
    }
}

fn cursor_for(event: &agentport_core::models::StatusEvent) -> AttentionCursor {
    AttentionCursor {
        occurred_at: event.occurred_at,
        session_id: event.session_id.clone(),
        run_ordinal: event.run_ordinal,
        sequence: event.sequence,
    }
}

fn check_file(file: &File) -> Result<()> {
    let meta = file.metadata().map_err(|_| Error::Storage)?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > MAX_STATE
    {
        return Err(Error::Storage);
    }
    Ok(())
}

fn file_options() -> OpenOptions {
    let mut opts = OpenOptions::new();
    opts.mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    opts
}

fn load(root: &Path) -> Result<CursorState> {
    let file = match file_options().read(true).open(root.join(FILE_NAME)) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(CursorState::default()),
        Err(_) => return Err(Error::Storage),
    };
    check_file(&file)?;
    let mut bytes = Vec::new();
    file.take(MAX_STATE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Storage)?;
    if bytes.len() as u64 > MAX_STATE {
        return Err(Error::Storage);
    }
    let state: CursorState = serde_json::from_slice(&bytes).map_err(|_| Error::Storage)?;
    if state.registrations.len() > 64 {
        return Err(Error::Storage);
    }
    Ok(state)
}

fn persist(root: &Path, state: &CursorState) -> Result<()> {
    let bytes = serde_json::to_vec(state).map_err(|_| Error::Storage)?;
    if bytes.len() as u64 > MAX_STATE {
        return Err(Error::Storage);
    }
    let destination = root.join(FILE_NAME);
    match fs::symlink_metadata(&destination) {
        Ok(_) => {
            let file = file_options()
                .read(true)
                .open(&destination)
                .map_err(|_| Error::Storage)?;
            check_file(&file)?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(Error::Storage),
    }
    let temporary = root.join(format!(".push-cursors-{}", identifier()?));
    let result = (|| {
        let mut file = file_options()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| Error::Storage)?;
        file.write_all(&bytes).map_err(|_| Error::Storage)?;
        file.sync_all().map_err(|_| Error::Storage)?;
        fs::rename(&temporary, &destination).map_err(|_| Error::Storage)?;
        File::open(root)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| Error::Storage)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn kind(event: &agentport_core::models::StatusEvent) -> Option<apns::AttentionKind> {
    use agentport_core::models::AttentionKind as CoreKind;
    match event.attention_kind()? {
        CoreKind::ApprovalRequested => Some(apns::AttentionKind::ApprovalRequested),
        CoreKind::TurnCompleted => Some(apns::AttentionKind::TurnCompleted),
        CoreKind::ExecutionFailed => Some(apns::AttentionKind::ExecutionFailed),
    }
}

/// One owner per connector. The caller supplies an already-open app DB and the
/// connector state directory (which is protected by its lifetime Store lock).
/// The APNs sender must be constructed for `environment`; other registrations
/// are ignored rather than sent to the wrong APNs endpoint.
///
/// `host_id` must be the existing opaque paired Host identifier, never a name.
/// Storage/DB errors stop this worker instead of dropping events or resetting
/// cursors. The caller should supervise/restart it after recovery.
pub async fn run(
    runtime: Arc<Runtime>,
    sender: Arc<apns::ApnsSender>,
    db: Arc<Db>,
    state_dir: PathBuf,
    host_id: String,
    environment: PushEnvironment,
    mut shutdown: watch::Receiver<bool>,
) -> Result<()> {
    if !(16..=128).contains(&host_id.len())
        || !host_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(Error::Invalid("opaque push host id"));
    }
    let root = private_directory(&state_dir)?;
    let mut state = load(&root)?;
    let mut retries: HashMap<String, Retry> = HashMap::new();
    loop {
        if *shutdown.borrow() {
            return Ok(());
        }
        let targets: Vec<_> = runtime
            .push_targets()
            .await
            .into_iter()
            .filter(|t| t.registration.environment == environment)
            .collect();
        let keys: Vec<_> = targets.iter().map(registration_key).collect();
        // An empty target snapshot may mean a temporarily unconfigured or
        // stopped Runtime, not revocation. Preserve outstanding cursors until
        // a nonempty authorized snapshot proves the registrations changed.
        if !keys.is_empty() {
            let previous_count = state.registrations.len();
            state.registrations.retain(|key, _| keys.contains(key));
            retries.retain(|key, _| keys.contains(key));
            if previous_count != state.registrations.len() {
                persist(&root, &state)?;
            }
        }
        for (target, key) in targets.iter().zip(keys) {
            if *shutdown.borrow() {
                return Ok(());
            }
            if !state.registrations.contains_key(&key) {
                // Authorization can change after push_targets() takes its snapshot.
                if !runtime.is_push_target_authorized(target).await {
                    continue;
                }
                state.registrations.insert(
                    key.clone(),
                    DeliveryState {
                        cursor: initial_cursor(target.registered_at_ms),
                        disabled: false,
                    },
                );
                persist(&root, &state)?; // No send before initial cursor is durable.
            }
            if state.registrations[&key].disabled
                || retries.get(&key).is_some_and(|r| Instant::now() < r.until)
            {
                continue;
            }
            let cursor = &state.registrations[&key].cursor;
            let events = db
                .poll_attention_events(Some(cursor), PAGE)
                .map_err(|_| Error::Storage)?;
            for event in events {
                if *shutdown.borrow() {
                    return Ok(());
                }
                // A revoked or replaced token must not receive subsequent events.
                if !runtime.is_push_target_authorized(target).await {
                    break;
                }
                let Some(alert_kind) = kind(&event) else {
                    return Err(Error::Storage); // DB predicate and semantic classifier diverged.
                };
                let result = sender
                    .send_alert(
                        &target.registration.token,
                        alert_kind,
                        &host_id,
                        &event.session_id,
                    )
                    .await;
                match apply_outcome(
                    state.registrations.get_mut(&key).unwrap(),
                    cursor_for(&event),
                    result,
                ) {
                    DeliveryDecision::Advanced => {
                        persist(&root, &state)?;
                        retries.remove(&key);
                    }
                    DeliveryDecision::Disabled => {
                        persist(&root, &state)?;
                        break;
                    }
                    DeliveryDecision::Retry => {
                        let next = retries.get(&key).map_or(Duration::from_secs(2), |r| {
                            r.delay.saturating_mul(2).min(MAX_BACKOFF)
                        });
                        retries.insert(
                            key.clone(),
                            Retry {
                                until: Instant::now() + next,
                                delay: next,
                            },
                        );
                        break; // No cursor movement: retry this event after backoff.
                    }
                    DeliveryDecision::Stop => {
                        // Do not discard events for a misconfigured provider or
                        // unsupported identifier; operator action is required.
                        return Err(Error::Storage);
                    }
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(POLL_INTERVAL) => {},
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() { return Ok(()); }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    #[test]
    fn registration_cursor_is_distinct_for_each_token_and_environment() {
        let mut target = PushTarget {
            public_key: "approved-phone".into(),
            registration: crate::endpoint::PushRegistration {
                token: "ab".repeat(32),
                environment: PushEnvironment::Sandbox,
            },
            registered_at_ms: Some(1234),
        };
        let first = registration_key(&target);
        target.registration.token = "cd".repeat(32);
        assert_ne!(first, registration_key(&target));
        target.registration.token = "ab".repeat(32);
        target.registration.environment = PushEnvironment::Production;
        assert_ne!(first, registration_key(&target));
        target.registration.environment = PushEnvironment::Sandbox;
        target.registered_at_ms = Some(1235);
        assert_ne!(first, registration_key(&target));
        assert!(!first.contains(&target.registration.token));
    }

    #[test]
    fn only_acceptance_checkpoints_and_registration_time_survives_worker_restart() {
        let baseline = initial_cursor(Some(1_700_000_000_123));
        assert_eq!(baseline.occurred_at.timestamp_millis(), 1_700_000_000_123);
        let later = initial_cursor(Some(1_700_000_020_123));
        let mut state = DeliveryState {
            cursor: baseline.clone(),
            disabled: false,
        };
        assert_eq!(
            apply_outcome(
                &mut state,
                later.clone(),
                Err(apns::PushError::Transient { status: Some(503) })
            ),
            DeliveryDecision::Retry
        );
        assert_eq!(state.cursor, baseline);
        assert_eq!(
            apply_outcome(
                &mut state,
                later.clone(),
                Err(apns::PushError::Permanent { status: 403 })
            ),
            DeliveryDecision::Stop
        );
        assert_eq!(state.cursor, baseline);
        assert_eq!(
            apply_outcome(&mut state, later.clone(), Ok(())),
            DeliveryDecision::Advanced
        );
        assert_eq!(state.cursor, later);
        assert_eq!(
            apply_outcome(&mut state, baseline, Err(apns::PushError::Revoked)),
            DeliveryDecision::Disabled
        );
        assert!(state.disabled);
        assert_eq!(state.cursor, later);
    }

    #[test]
    fn cursor_file_is_private_atomic_and_rejects_unsafe_replacements() {
        let tmp = tempfile::tempdir().unwrap();
        let root = private_directory(&tmp.path().join("state")).unwrap();
        let mut state = CursorState::default();
        state.registrations.insert(
            "opaque-device-key".into(),
            DeliveryState {
                cursor: initial_cursor(Some(1234)),
                disabled: false,
            },
        );
        persist(&root, &state).unwrap();
        assert_eq!(load(&root).unwrap().registrations.len(), 1);
        assert_eq!(
            fs::metadata(root.join(FILE_NAME)).unwrap().mode() & 0o777,
            0o600
        );
        fs::set_permissions(root.join(FILE_NAME), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&root).is_err());
        assert!(persist(&root, &state).is_err());
        fs::remove_file(root.join(FILE_NAME)).unwrap();
        let sentinel = tmp.path().join("sentinel");
        fs::write(&sentinel, b"unchanged").unwrap();
        symlink(&sentinel, root.join(FILE_NAME)).unwrap();
        assert!(load(&root).is_err());
        assert!(persist(&root, &state).is_err());
        assert_eq!(fs::read(&sentinel).unwrap(), b"unchanged");
    }
}
