//! In-app updates (Tauri updater plugin).
//!
//! Release model: one release carries exactly one version for the Tauri shell,
//! the embedded Vite/React dist and every bundled sidecar (`bundle.externalBin`
//! entries such as `agentport-host`). `Update::install` replaces the whole
//! `.app` — sidecars included — so there is deliberately no per-sidecar
//! download or replacement path.
//!
//! Session safety: Session Hosts are independent processes that stay alive when
//! the GUI quits (PRD ch.6). Installing an update replaces the sidecar binaries,
//! so the GUI first stops every live Host gracefully, verifies that its process
//! group is gone, and aborts the install — keeping the running version — when
//! that cannot be proven.
//!
//! Debug builds never talk to the release feed: `cfg!(debug_assertions)` or
//! `AGENTPORT_UPDATER_DISABLED` short-circuits the startup probe and every
//! command, so `tauri dev` / the checkout debug App can never self-update into
//! a release build.

use crate::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Event carrying [`UpdateSnapshot`] to the WebView.
pub const UPDATE_STATE_EVENT: &str = "update-state";
/// Progress events are coalesced; the terminal states are always delivered.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdatePhase {
    /// Builds that must never self-update (debug profile, explicit opt-out).
    Disabled,
    Idle,
    Checking,
    UpToDate,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSnapshot {
    pub phase: UpdatePhase,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
    /// Live Sessions the install step would stop; read when reporting state.
    pub live_sessions: usize,
}

impl UpdateSnapshot {
    fn new(current_version: String, phase: UpdatePhase) -> Self {
        Self {
            phase,
            current_version,
            version: None,
            notes: None,
            date: None,
            downloaded: 0,
            total: None,
            error: None,
            live_sessions: 0,
        }
    }
}

#[derive(Default)]
pub struct UpdateState {
    snapshot: Mutex<Option<UpdateSnapshot>>,
    pending: Mutex<Option<Update>>,
    payload: Mutex<Option<Vec<u8>>>,
    busy: AtomicBool,
}

impl UpdateState {
    fn snapshot(&self, current_version: &str) -> UpdateSnapshot {
        self.snapshot
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| UpdateSnapshot::new(current_version.to_string(), UpdatePhase::Idle))
    }

    /// Mutate the stored snapshot and return the new value.
    fn update(
        &self,
        current_version: &str,
        mutate: impl FnOnce(&mut UpdateSnapshot),
    ) -> UpdateSnapshot {
        let mut guard = self.snapshot.lock().unwrap();
        let snapshot = guard.get_or_insert_with(|| {
            UpdateSnapshot::new(current_version.to_string(), UpdatePhase::Idle)
        });
        mutate(snapshot);
        snapshot.clone()
    }

    fn pending(&self) -> Option<Update> {
        self.pending.lock().unwrap().clone()
    }

    fn take_payload(&self) -> Option<Vec<u8>> {
        self.payload.lock().unwrap().take()
    }
}

/// Platforms whose bundle the Tauri updater can replace in place. Linux
/// deb/rpm/tarball installs are owned by the system package manager, and the
/// release pipeline does not publish Linux updater payloads (the bundler only
/// produces them from an AppImage, which is currently blocked), so those
/// installs stay on the manual upgrade path instead of failing a download.
fn platform_supports_updater() -> bool {
    #[cfg(target_os = "linux")]
    {
        return std::env::var_os("APPIMAGE").is_some();
    }
    #[cfg(not(target_os = "linux"))]
    {
        true
    }
}

/// Whether this build may contact the release feed.
pub fn updater_enabled() -> bool {
    if cfg!(debug_assertions) {
        return false;
    }
    if !platform_supports_updater() {
        return false;
    }
    std::env::var_os("AGENTPORT_UPDATER_DISABLED").is_none()
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn publish(app: &AppHandle, snapshot: &UpdateSnapshot) {
    if let Err(error) = app.emit(UPDATE_STATE_EVENT, snapshot) {
        tracing::warn!(error = %error, "update state event delivery failed");
    }
}

/// Publish a terminal or user-visible state change.
fn commit(
    app: &AppHandle,
    state: &UpdateState,
    mutate: impl FnOnce(&mut UpdateSnapshot),
) -> UpdateSnapshot {
    let snapshot = state.update(&current_version(app), mutate);
    publish(app, &snapshot);
    snapshot
}

fn live_session_count(core: &AppState) -> usize {
    core.db
        .list_sessions(None, false)
        .map(|sessions| {
            sessions
                .iter()
                .filter(|session| crate::live_session(session.lifecycle))
                .count()
        })
        .unwrap_or(0)
}

/// Startup probe: check once, download in the background, leave the update
/// pending for an explicit "restart and update" click. Called from `setup`.
pub async fn startup_check(app: AppHandle) {
    let state = app.state::<UpdateState>();
    if !updater_enabled() {
        tracing::info!(
            debug = cfg!(debug_assertions),
            platform = std::env::consts::OS,
            "updater disabled for this build"
        );
        commit(&app, &state, |snapshot| {
            snapshot.phase = UpdatePhase::Disabled;
        });
        return;
    }
    let core = app.state::<AppState>();
    match check(&app, &state, &core).await {
        Ok(snapshot) if snapshot.phase == UpdatePhase::Available => {
            if let Err(error) = download(&app, &state, &core).await {
                tracing::warn!(error = %error, "background update download failed");
            }
        }
        Ok(_) => {}
        Err(error) => tracing::warn!(error = %error, "startup update check failed"),
    }
}

async fn check(
    app: &AppHandle,
    state: &UpdateState,
    core: &AppState,
) -> Result<UpdateSnapshot, String> {
    commit(app, state, |snapshot| {
        snapshot.phase = UpdatePhase::Checking;
        snapshot.error = None;
        snapshot.live_sessions = live_session_count(core);
    });
    let updater = app.updater().map_err(|error| error.to_string())?;
    let checked = updater.check().await;
    match checked {
        Ok(Some(update)) => {
            let live = live_session_count(core);
            let version = update.version.clone();
            let notes = update.body.clone();
            let date = update.date.map(|date| date.to_string());
            tracing::info!(version = %version, current = %update.current_version, "update available");
            *state.pending.lock().unwrap() = Some(update);
            // A re-check invalidates any previously downloaded payload.
            state.payload.lock().unwrap().take();
            Ok(commit(app, state, |snapshot| {
                snapshot.phase = UpdatePhase::Available;
                snapshot.version = Some(version);
                snapshot.notes = notes;
                snapshot.date = date;
                snapshot.downloaded = 0;
                snapshot.total = None;
                snapshot.error = None;
                snapshot.live_sessions = live;
            }))
        }
        Ok(None) => Ok(commit(app, state, |snapshot| {
            tracing::info!(current = %snapshot.current_version, "no update available");
            snapshot.phase = UpdatePhase::UpToDate;
            snapshot.version = None;
            snapshot.notes = None;
            snapshot.date = None;
            snapshot.downloaded = 0;
            snapshot.total = None;
            snapshot.error = None;
            snapshot.live_sessions = live_session_count(core);
        })),
        Err(error) => {
            let message = error.to_string();
            tracing::warn!(error = %message, "update check failed");
            Ok(commit(app, state, |snapshot| {
                snapshot.phase = UpdatePhase::Error;
                snapshot.error = Some(message);
                snapshot.live_sessions = live_session_count(core);
            }))
        }
    }
}

async fn download(
    app: &AppHandle,
    state: &UpdateState,
    core: &AppState,
) -> Result<UpdateSnapshot, String> {
    if state.busy.swap(true, Ordering::AcqRel) {
        return Err("an update download is already running".into());
    }
    let result = download_inner(app, state, core).await;
    state.busy.store(false, Ordering::Release);
    result
}

async fn download_inner(
    app: &AppHandle,
    state: &UpdateState,
    core: &AppState,
) -> Result<UpdateSnapshot, String> {
    let update = state
        .pending()
        .ok_or_else(|| "no update is pending; check for updates first".to_string())?;
    let live = live_session_count(core);
    commit(app, state, |snapshot| {
        snapshot.phase = UpdatePhase::Downloading;
        snapshot.downloaded = 0;
        snapshot.total = None;
        snapshot.error = None;
        snapshot.live_sessions = live;
    });

    let downloaded = Mutex::new(0u64);
    let last_emit = Mutex::new(Instant::now());
    let payload = update
        .download(
            |chunk, total| {
                let mut bytes = downloaded.lock().unwrap();
                *bytes += chunk as u64;
                let mut last = last_emit.lock().unwrap();
                if last.elapsed() < PROGRESS_EMIT_INTERVAL {
                    return;
                }
                *last = Instant::now();
                let snapshot = state.update(&current_version(app), |snapshot| {
                    snapshot.phase = UpdatePhase::Downloading;
                    snapshot.downloaded = *bytes;
                    snapshot.total = total;
                });
                publish(app, &snapshot);
            },
            || {},
        )
        .await;

    match payload {
        Ok(bytes) => {
            let size = bytes.len() as u64;
            tracing::info!(
                bytes = size,
                "update payload downloaded and signature verified"
            );
            *state.payload.lock().unwrap() = Some(bytes);
            Ok(commit(app, state, |snapshot| {
                snapshot.phase = UpdatePhase::Ready;
                snapshot.downloaded = size;
                snapshot.total = Some(size);
                snapshot.error = None;
                snapshot.live_sessions = live;
            }))
        }
        Err(error) => {
            let message = error.to_string();
            tracing::warn!(error = %message, "update download failed");
            commit(app, state, |snapshot| {
                snapshot.phase = UpdatePhase::Available;
                snapshot.downloaded = 0;
                snapshot.total = None;
                snapshot.error = Some(message.clone());
            });
            Err(message)
        }
    }
}

#[tauri::command]
pub fn update_status(
    app: AppHandle,
    state: State<'_, UpdateState>,
    core: State<'_, AppState>,
) -> UpdateSnapshot {
    let mut snapshot = state.snapshot(&current_version(&app));
    if !updater_enabled() {
        snapshot.phase = UpdatePhase::Disabled;
    }
    snapshot.live_sessions = live_session_count(&core);
    snapshot
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, UpdateState>,
    core: State<'_, AppState>,
) -> Result<UpdateSnapshot, String> {
    if !updater_enabled() {
        return Err("updates are disabled in this build".into());
    }
    check(&app, &state, &core).await
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    state: State<'_, UpdateState>,
    core: State<'_, AppState>,
) -> Result<UpdateSnapshot, String> {
    if !updater_enabled() {
        return Err("updates are disabled in this build".into());
    }
    download(&app, &state, &core).await
}

/// Install the downloaded update: stop every live Session Host gracefully,
/// verify the process groups are gone, then let the updater replace the app
/// bundle and relaunch. Any unproven cleanup aborts the install.
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    state: State<'_, UpdateState>,
    core: State<'_, AppState>,
) -> Result<(), String> {
    if !updater_enabled() {
        return Err("updates are disabled in this build".into());
    }
    let update = state
        .pending()
        .ok_or_else(|| "no update is pending; check for updates first".to_string())?;
    let payload = state
        .take_payload()
        .ok_or_else(|| "the update payload is not downloaded yet".to_string())?;

    commit(&app, &state, |snapshot| {
        snapshot.phase = UpdatePhase::Installing;
        snapshot.error = None;
        snapshot.live_sessions = live_session_count(&core);
    });

    let handle = app.clone();
    let stopped = tauri::async_runtime::spawn_blocking(move || {
        let core = handle.state::<AppState>();
        // Persist renderer-confirmed recovery boundaries exactly like a normal
        // GUI exit, then stop the Hosts whose binaries are about to be replaced.
        crate::capture_gui_exit_recovery_boundaries(&core);
        crate::stop_live_sessions_for_update(&core)
    })
    .await
    .map_err(|error| format!("update worker failed: {error}"))?;

    match stopped {
        Ok(count) => tracing::info!(sessions = count, "stopped Session Hosts for update"),
        Err(error) => {
            commit(&app, &state, |snapshot| {
                snapshot.phase = UpdatePhase::Ready;
                snapshot.error = Some(error.clone());
            });
            return Err(error);
        }
    }

    if let Err(error) = update.install(payload) {
        let message = error.to_string();
        commit(&app, &state, |snapshot| {
            snapshot.phase = UpdatePhase::Ready;
            snapshot.error = Some(message.clone());
        });
        return Err(message);
    }
    tracing::info!(version = %update.version, "update installed; restarting AgentPort");
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_serializes_to_the_frontend_contract() {
        let mut snapshot = UpdateSnapshot::new("1.2.3".into(), UpdatePhase::Ready);
        snapshot.version = Some("1.3.0".into());
        snapshot.downloaded = 42;
        snapshot.total = Some(64);
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["phase"], "ready");
        assert_eq!(value["currentVersion"], "1.2.3");
        assert_eq!(value["version"], "1.3.0");
        assert_eq!(value["downloaded"], 42);
        assert_eq!(value["total"], 64);
        assert_eq!(value["liveSessions"], 0);
        assert_eq!(value["error"], serde_json::Value::Null);
        assert_eq!(
            serde_json::to_value(UpdatePhase::UpToDate).unwrap(),
            "upToDate"
        );
        assert_eq!(
            serde_json::to_value(UpdatePhase::Disabled).unwrap(),
            "disabled"
        );
    }

    #[test]
    fn update_state_keeps_the_snapshot_between_updates() {
        let state = UpdateState::default();
        let first = state.update("1.0.0", |snapshot| {
            snapshot.phase = UpdatePhase::Checking;
        });
        assert_eq!(first.current_version, "1.0.0");
        assert_eq!(first.phase, UpdatePhase::Checking);
        let second = state.update("1.0.0", |snapshot| {
            snapshot.phase = UpdatePhase::UpToDate;
        });
        assert_eq!(second.phase, UpdatePhase::UpToDate);
        assert_eq!(state.snapshot("1.0.0").phase, UpdatePhase::UpToDate);
    }

    #[test]
    fn environment_override_disables_updates_for_any_build() {
        let previous = std::env::var_os("AGENTPORT_UPDATER_DISABLED");
        std::env::set_var("AGENTPORT_UPDATER_DISABLED", "1");
        assert!(!updater_enabled());
        match previous {
            Some(value) => std::env::set_var("AGENTPORT_UPDATER_DISABLED", value),
            None => std::env::remove_var("AGENTPORT_UPDATER_DISABLED"),
        }
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_builds_never_contact_the_release_feed() {
        std::env::remove_var("AGENTPORT_UPDATER_DISABLED");
        assert!(!updater_enabled());
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn bundle_formats_the_updater_can_replace_are_supported() {
        std::env::remove_var("AGENTPORT_UPDATER_DISABLED");
        assert!(platform_supports_updater());
    }
}
