//! Foreground, single-job downloads. Binary content never crosses the JS bridge.
use crate::remote::{RemoteCommandError, RemoteConnections};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
#[cfg(any(target_os = "ios", target_os = "android", test))]
use tauri::Manager;
use tauri::{AppHandle, Runtime, State};
use tokio::{io::AsyncWriteExt, sync::Mutex};

const MAX_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_CHUNK: usize = 262144;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadError {
    code: String,
    message: String,
}
fn error(code: &str) -> DownloadError {
    let message = match code {
        "upgrade_required" => "Update the remote host to support file downloads.",
        "unsupported_platform" => "File saving requires the iOS or Android app.",
        "download_busy" => "Finish, save or cancel the current download first.",
        "save_in_progress" => {
            "Use the system picker to finish or cancel saving; wait for it to close."
        }
        "invalid_job" => "This download is no longer available.",
        "not_ready" => "The download is not ready to save.",
        "cancelled" => "Download cancelled.",
        "disk_error" => "Unable to write the temporary file. Check available storage.",
        "cleanup_failed" => "Unable to remove the temporary download. Restart the app to retry cleanup.",
        "saved_cleanup_failed" => "The file was saved, but its temporary copy could not be removed. Restart the app to retry cleanup.",
        "save_failed_leftover" => {
            "Saving failed and the incomplete destination could not be removed. Remove it in Files."
        }
        "save_failed" => "Unable to save the file. Check the destination and available storage.",
        "connection_changed" => "The host connection ended or changed. Reconnect and start again.",
        "file_too_large" => "Files larger than 1 GiB cannot be downloaded.",
        "source_changed" => "The source file changed. Start the download again.",
        "path_outside_root" | "invalid_path" => "The file path is not allowed.",
        "file_not_found" | "not_found" => "The source file is no longer available.",
        "permission_denied" => "The source file cannot be read.",
        "integrity_error" => "The downloaded file failed integrity verification.",
        _ => "The file download failed. Start again.",
    };
    DownloadError {
        code: code.into(),
        message: message.into(),
    }
}
impl From<std::io::Error> for DownloadError {
    fn from(_: std::io::Error) -> Self {
        error("disk_error")
    }
}
impl From<RemoteCommandError> for DownloadError {
    fn from(value: RemoteCommandError) -> Self {
        error(match value.code.as_str() {
            "unknown_method" | "method_not_found" | "unsupported_method" => "upgrade_required",
            "connection_unknown"
            | "request_timeout"
            | "connection_write_failed"
            | "host_not_connected" => "connection_changed",
            code => code,
        })
    }
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    Downloading,
    Ready,
    Saving,
    Saved,
    Failed,
    Cancelled,
}
impl DownloadState {
    fn busy(&self) -> bool {
        matches!(self, Self::Downloading | Self::Ready | Self::Saving)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSnapshot {
    job_id: String,
    profile_id: String,
    session_id: String,
    path: String,
    name: String,
    total_bytes: u64,
    received_bytes: u64,
    state: DownloadState,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<DownloadError>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownloadRequest {
    profile_id: String,
    session_id: String,
    path: String,
}

struct OwnedDirectory(PathBuf);
impl OwnedDirectory {
    fn cleanup(&self) -> Result<(), DownloadError> {
        match std::fs::remove_dir_all(&self.0) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(error("cleanup_failed")),
        }
    }
}
impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct Job {
    snapshot: DownloadSnapshot,
    cancel: Arc<AtomicBool>,
    directory: Option<Arc<OwnedDirectory>>,
}
impl Job {
    #[cfg(any(target_os = "ios", target_os = "android", test))]
    fn complete_export(&mut self, status: Result<&str, ()>) {
        match status {
            Ok("saved") => self.snapshot.state = DownloadState::Saved,
            Ok("cancelled") => self.snapshot.state = DownloadState::Cancelled,
            Ok("save_failed_leftover") => {
                self.snapshot.state = DownloadState::Failed;
                self.snapshot.error = Some(error("save_failed_leftover"));
            }
            _ => {
                self.snapshot.state = DownloadState::Failed;
                self.snapshot.error = Some(error("save_failed"));
            }
        }
        if let Err(e) = self.cleanup() {
            if self.snapshot.state == DownloadState::Saved {
                self.snapshot.error = Some(error("saved_cleanup_failed"));
            } else if self
                .snapshot
                .error
                .as_ref()
                .is_some_and(|e| e.code == "save_failed_leftover")
            {
                // Destination debris is more consequential than our private
                // cache debris. Never hide the warning to remove it in Files.
                self.snapshot.error.as_mut().unwrap().message.push_str(" The temporary download also could not be removed; restart the app to retry cleanup.");
            } else {
                self.snapshot.error = Some(e);
            }
        }
    }
    fn cleanup(&mut self) -> Result<(), DownloadError> {
        if let Some(directory) = &self.directory {
            directory.cleanup()?;
        }
        self.directory = None;
        Ok(())
    }
}
#[derive(Clone)]
pub struct FileDownloads {
    root: Result<Arc<PathBuf>, DownloadError>,
    job: Arc<Mutex<Option<Job>>>,
}
impl FileDownloads {
    /// Cache failures disable only this feature, never the terminal/App. A
    /// failed initialization remains fail-closed until restart: do not start
    /// from a partially swept or untrusted directory.
    pub fn initialize(cache: tauri::Result<PathBuf>) -> Self {
        match cache
            .map_err(|_| error("disk_error"))
            .and_then(|cache| Self::new(&cache))
        {
            Ok(manager) => manager,
            Err(mut initial_error) => {
                initial_error.message.push_str(" Downloads are unavailable until the cache issue is fixed and the app is restarted.");
                Self {
                    root: Err(initial_error),
                    job: Arc::new(Mutex::new(None)),
                }
            }
        }
    }
    fn root(&self) -> Result<&Path, DownloadError> {
        self.root
            .as_ref()
            .map(|root| root.as_path())
            .map_err(Clone::clone)
    }
    pub fn new(cache: &Path) -> Result<Self, DownloadError> {
        let root = cache.join("agentport-file-downloads");
        std::fs::create_dir_all(cache)?;
        match std::fs::create_dir(&root) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e.into()),
        }
        if std::fs::symlink_metadata(&root)?.file_type().is_symlink() || !root.is_dir() {
            return Err(error("disk_error"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))?;
        }
        // App startup is the only sweep; no concurrently active job exists yet.
        for entry in std::fs::read_dir(&root).map_err(|_| error("cleanup_failed"))? {
            let entry = entry.map_err(|_| error("cleanup_failed"))?;
            if uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_ok() {
                if entry
                    .file_type()
                    .map_err(|_| error("cleanup_failed"))?
                    .is_dir()
                {
                    std::fs::remove_dir_all(entry.path()).map_err(|_| error("cleanup_failed"))?;
                } else {
                    std::fs::remove_file(entry.path()).map_err(|_| error("cleanup_failed"))?;
                }
            }
        }
        Ok(Self {
            root: Ok(Arc::new(root.canonicalize()?)),
            job: Arc::new(Mutex::new(None)),
        })
    }
    async fn snapshot(&self, id: &str) -> Result<DownloadSnapshot, DownloadError> {
        self.job
            .lock()
            .await
            .as_ref()
            .filter(|job| job.snapshot.job_id == id)
            .map(|job| job.snapshot.clone())
            .ok_or_else(|| error("invalid_job"))
    }
    async fn complete(&self, id: &str, result: Result<(), DownloadError>) {
        let mut jobs = self.job.lock().await;
        if let Some(job) = jobs.as_mut().filter(|job| job.snapshot.job_id == id) {
            if job.cancel.load(Ordering::Acquire) {
                job.snapshot.state = DownloadState::Cancelled;
                job.snapshot.error = None;
                if let Err(e) = job.cleanup() {
                    job.snapshot.error = Some(e);
                }
            } else if let Err(e) = result {
                job.snapshot.state = DownloadState::Failed;
                job.snapshot.error = Some(e);
                if let Err(e) = job.cleanup() {
                    job.snapshot.error = Some(e);
                }
            } else {
                job.snapshot.state = DownloadState::Ready;
            }
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    download_id: String,
    name: String,
    size_bytes: u64,
    chunk_bytes: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    offset: u64,
    content_base64: String,
    eof: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Finish {
    size_bytes: u64,
    sha256: String,
}
fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, DownloadError> {
    serde_json::from_value(value).map_err(|_| error("integrity_error"))
}
fn validate_open(open: &Open) -> Result<(), DownloadError> {
    if open.size_bytes > MAX_BYTES {
        return Err(error("file_too_large"));
    }
    if open.chunk_bytes == 0
        || open.chunk_bytes > MAX_CHUNK
        || open.download_id.is_empty()
        || open.download_id.len() > 256
        || open.name.is_empty()
        || open.name.len() > 255
        || open.name == "."
        || open.name == ".."
        || open.name.contains(['/', '\\'])
        || open.name.chars().any(char::is_control)
    {
        return Err(error("integrity_error"));
    }
    Ok(())
}
struct Verifier {
    total: u64,
    received: u64,
    chunk_limit: usize,
    hash: Sha256,
}
impl Verifier {
    fn new(open: &Open) -> Result<Self, DownloadError> {
        validate_open(open)?;
        Ok(Self {
            total: open.size_bytes,
            received: 0,
            chunk_limit: open.chunk_bytes,
            hash: Sha256::new(),
        })
    }
    fn chunk(&mut self, chunk: Chunk) -> Result<Vec<u8>, DownloadError> {
        if chunk.offset != self.received
            || chunk.content_base64.len() > self.chunk_limit.div_ceil(3) * 4
        {
            return Err(error("integrity_error"));
        }
        let bytes = STANDARD
            .decode(chunk.content_base64)
            .map_err(|_| error("integrity_error"))?;
        let next = self
            .received
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| error("integrity_error"))?;
        if bytes.len() > self.chunk_limit
            || next > self.total
            || chunk.eof != (next == self.total)
            || (bytes.is_empty() && self.total != 0)
        {
            return Err(error("integrity_error"));
        }
        self.hash.update(&bytes);
        self.received = next;
        Ok(bytes)
    }
    fn finish(self, finish: Finish) -> Result<(), DownloadError> {
        let digest = format!("{:x}", self.hash.finalize());
        if self.received != self.total || finish.size_bytes != self.total || finish.sha256 != digest
        {
            Err(error("integrity_error"))
        } else {
            Ok(())
        }
    }
}
fn check_cancel(cancel: &AtomicBool) -> Result<(), DownloadError> {
    if cancel.load(Ordering::Acquire) {
        Err(error("cancelled"))
    } else {
        Ok(())
    }
}
async fn transfer<R: Runtime>(
    app: &AppHandle<R>,
    connections: &RemoteConnections,
    manager: &FileDownloads,
    initial: &DownloadSnapshot,
    generation: &str,
    cancel: &AtomicBool,
    directory: &OwnedDirectory,
) -> Result<(), DownloadError> {
    check_cancel(cancel)?;
    let open: Open = parse(
        connections
            .download_request(
                app,
                &initial.profile_id,
                generation,
                "session.files.download.open",
                json!({"sessionId":initial.session_id,"path":initial.path}),
            )
            .await?,
    )?;
    // Once a token exists, always attempt close on errors/cancel (same generation).
    let result = async {
        check_cancel(cancel)?;
        let mut verifier = Verifier::new(&open)?;
        let source = directory.0.join(&open.name);
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&source)
            .await
            .map_err(|_| error("disk_error"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .await
                .map_err(|_| error("disk_error"))?;
        }
        {
            let mut jobs = manager.job.lock().await;
            let job = jobs.as_mut().ok_or_else(|| error("invalid_job"))?;
            job.snapshot.name = open.name.clone();
            job.snapshot.total_bytes = open.size_bytes;
        }
        // Empty files still request a zero-byte EOF chunk, matching the server's
        // sequential protocol and avoiding special-case integrity assumptions.
        loop {
            check_cancel(cancel)?;
            let chunk = parse(
                connections
                    .download_request(
                        app,
                        &initial.profile_id,
                        generation,
                        "session.files.download.chunk",
                        json!({"downloadId":open.download_id,"offset":verifier.received}),
                    )
                    .await?,
            )?;
            check_cancel(cancel)?;
            let bytes = verifier.chunk(chunk)?;
            file.write_all(&bytes)
                .await
                .map_err(|_| error("disk_error"))?;
            drop(bytes);
            {
                let mut jobs = manager.job.lock().await;
                jobs.as_mut()
                    .ok_or_else(|| error("invalid_job"))?
                    .snapshot
                    .received_bytes = verifier.received;
            }
            if verifier.received == verifier.total {
                break;
            }
        }
        file.flush().await.map_err(|_| error("disk_error"))?;
        file.sync_all().await.map_err(|_| error("disk_error"))?;
        drop(file);
        check_cancel(cancel)?;
        let finish = parse(
            connections
                .download_request(
                    app,
                    &initial.profile_id,
                    generation,
                    "session.files.download.finish",
                    json!({"downloadId":open.download_id}),
                )
                .await?,
        )?;
        verifier.finish(finish)?;
        check_cancel(cancel)?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = connections
            .download_request(
                app,
                &initial.profile_id,
                generation,
                "session.files.download.close",
                json!({"downloadId":open.download_id}),
            )
            .await;
    }
    result
}

#[tauri::command]
pub async fn mobile_file_download_start(
    app: AppHandle,
    manager: State<'_, FileDownloads>,
    connections: State<'_, RemoteConnections>,
    request: DownloadRequest,
) -> Result<DownloadSnapshot, DownloadError> {
    let root = manager.root()?;
    if !cfg!(any(target_os = "ios", target_os = "android")) {
        return Err(error("unsupported_platform"));
    }
    let mut jobs = manager.job.lock().await;
    if jobs.as_ref().is_some_and(|job| job.snapshot.state.busy()) {
        return Err(error("download_busy"));
    }
    let generation = connections.download_generation(&request.profile_id).await?;
    if let Some(job) = jobs.as_mut() {
        job.cleanup()?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = root.join(&id);
    std::fs::create_dir(&path).map_err(|_| error("disk_error"))?;
    let directory = Arc::new(OwnedDirectory(path.clone()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| error("disk_error"))?;
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let snapshot = DownloadSnapshot {
        job_id: id.clone(),
        profile_id: request.profile_id,
        session_id: request.session_id,
        path: request.path,
        name: String::new(),
        total_bytes: 0,
        received_bytes: 0,
        state: DownloadState::Downloading,
        error: None,
    };
    *jobs = Some(Job {
        snapshot: snapshot.clone(),
        cancel: cancel.clone(),
        directory: Some(directory.clone()),
    });
    drop(jobs);
    let manager = manager.inner().clone();
    let connections = connections.inner().clone();
    let initial = snapshot.clone();
    tauri::async_runtime::spawn(async move {
        let result = transfer(
            &app,
            &connections,
            &manager,
            &initial,
            &generation,
            &cancel,
            &directory,
        )
        .await;
        // Drop the worker's ownership before publishing terminal state, so a
        // cancelled/failed job cannot race a replacement's cleanup.
        drop(directory);
        manager.complete(&id, result).await;
    });
    Ok(snapshot)
}
#[tauri::command]
pub async fn mobile_file_download_poll(
    manager: State<'_, FileDownloads>,
    job_id: String,
) -> Result<DownloadSnapshot, DownloadError> {
    manager.snapshot(&job_id).await
}
#[tauri::command]
pub async fn mobile_file_download_cancel(
    manager: State<'_, FileDownloads>,
    job_id: String,
) -> Result<DownloadSnapshot, DownloadError> {
    let mut jobs = manager.job.lock().await;
    let job = jobs
        .as_mut()
        .filter(|job| job.snapshot.job_id == job_id)
        .ok_or_else(|| error("invalid_job"))?;
    match job.snapshot.state {
        DownloadState::Saving => return Err(error("save_in_progress")),
        DownloadState::Downloading => {
            job.cancel.store(true, Ordering::Release);
        }
        DownloadState::Ready => {
            job.snapshot.state = DownloadState::Cancelled;
            if let Err(e) = job.cleanup() {
                job.snapshot.error = Some(e);
            }
        }
        _ => {}
    }
    Ok(job.snapshot.clone())
}
#[tauri::command]
pub async fn mobile_file_download_discard(
    manager: State<'_, FileDownloads>,
    job_id: String,
) -> Result<(), DownloadError> {
    let mut jobs = manager.job.lock().await;
    let job = jobs
        .as_mut()
        .filter(|job| job.snapshot.job_id == job_id)
        .ok_or_else(|| error("invalid_job"))?;
    if matches!(
        job.snapshot.state,
        DownloadState::Saving | DownloadState::Downloading
    ) {
        return Err(error("download_busy"));
    }
    job.cleanup()?;
    *jobs = None;
    Ok(())
}
#[tauri::command]
pub async fn mobile_file_download_save(
    app: AppHandle,
    manager: State<'_, FileDownloads>,
    job_id: String,
) -> Result<DownloadSnapshot, DownloadError> {
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let _ = (app, manager, job_id);
        Err(error("unsupported_platform"))
    }
    #[cfg(any(target_os = "ios", target_os = "android"))]
    {
        let (directory, name) = {
            let mut jobs = manager.job.lock().await;
            let job = jobs
                .as_mut()
                .filter(|job| job.snapshot.job_id == job_id)
                .ok_or_else(|| error("invalid_job"))?;
            if job.snapshot.state != DownloadState::Ready {
                return Err(error("not_ready"));
            }
            let directory = job.directory.clone().ok_or_else(|| error("invalid_job"))?;
            job.snapshot.state = DownloadState::Saving;
            (directory, job.snapshot.name.clone())
        };
        let outcome = app
            .state::<tauri_plugin_file_export::FileExport<tauri::Wry>>()
            .export(manager.root()?, &directory.0.join(&name), &name, &job_id)
            .await;
        // Save cannot be cancelled/discarded/replaced while the exporter reads.
        drop(directory);
        let mut jobs = manager.job.lock().await;
        let job = jobs.as_mut().ok_or_else(|| error("invalid_job"))?;
        job.complete_export(
            outcome
                .as_ref()
                .map(|result| result.status.as_str())
                .map_err(|_| ()),
        );
        Ok(job.snapshot.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn open(size: u64) -> Open {
        Open {
            download_id: "token".into(),
            name: "test.bin".into(),
            size_bytes: size,
            chunk_bytes: MAX_CHUNK,
        }
    }
    fn chunk(offset: u64, bytes: &[u8], eof: bool) -> Chunk {
        Chunk {
            offset,
            content_base64: STANDARD.encode(bytes),
            eof,
        }
    }
    #[test]
    fn bounded_chunks_hash_and_empty() {
        let mut verifier = Verifier::new(&open(3)).unwrap();
        assert_eq!(
            verifier.chunk(chunk(0, &[0, 255], false)).unwrap(),
            [0, 255]
        );
        verifier.chunk(chunk(2, &[17], true)).unwrap();
        verifier
            .finish(Finish {
                size_bytes: 3,
                sha256: format!("{:x}", Sha256::digest([0, 255, 17])),
            })
            .unwrap();
        let mut empty = Verifier::new(&open(0)).unwrap();
        empty.chunk(chunk(0, &[], true)).unwrap();
        empty
            .finish(Finish {
                size_bytes: 0,
                sha256: format!("{:x}", Sha256::digest([])),
            })
            .unwrap();
    }
    #[test]
    fn rejects_offsets_eof_overflow_and_bad_digest() {
        assert!(Verifier::new(&open(1))
            .unwrap()
            .chunk(chunk(1, &[1], true))
            .is_err());
        assert!(Verifier::new(&open(1))
            .unwrap()
            .chunk(chunk(0, &[1], false))
            .is_err());
        assert!(Verifier::new(&open(1))
            .unwrap()
            .chunk(chunk(0, &[1, 2], true))
            .is_err());
        assert!(Verifier::new(&open(1))
            .unwrap()
            .chunk(chunk(0, &[], false))
            .is_err());
        assert!(Verifier::new(&open(MAX_BYTES + 1)).is_err());
        assert!(Verifier::new(&open(0))
            .unwrap()
            .finish(Finish {
                size_bytes: 0,
                sha256: "bad".into()
            })
            .is_err());
        assert!(Verifier::new(&open(MAX_CHUNK as u64 + 1))
            .unwrap()
            .chunk(chunk(0, &vec![0; MAX_CHUNK + 1], true))
            .is_err());
    }
    #[test]
    fn rejects_names_and_accepts_one_gib_without_allocation() {
        let mut value = open(MAX_BYTES);
        assert!(Verifier::new(&value).is_ok());
        for name in ["../x", "/x", "..", ".", "a\\b", "bad\0name"] {
            value.name = name.into();
            assert!(validate_open(&value).is_err());
        }
    }
    #[test]
    fn single_job_states_and_cancel_flag() {
        for state in [
            DownloadState::Downloading,
            DownloadState::Ready,
            DownloadState::Saving,
        ] {
            assert!(state.busy());
        }
        for state in [
            DownloadState::Saved,
            DownloadState::Failed,
            DownloadState::Cancelled,
        ] {
            assert!(!state.busy());
        }
        let flag = AtomicBool::new(false);
        assert!(check_cancel(&flag).is_ok());
        flag.store(true, Ordering::Release);
        assert!(check_cancel(&flag).is_err());
    }
    #[tokio::test]
    async fn terminal_cancel_cleans_owned_directory_and_retains_snapshot() {
        let cache = std::env::temp_dir().join(format!("download-test-{}", uuid::Uuid::new_v4()));
        let manager = FileDownloads::new(&cache).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let directory = manager.root().unwrap().join(&id);
        std::fs::create_dir(&directory).unwrap();
        *manager.job.lock().await = Some(Job {
            snapshot: DownloadSnapshot {
                job_id: id.clone(),
                profile_id: "p".into(),
                session_id: "s".into(),
                path: "file".into(),
                name: "file".into(),
                total_bytes: 0,
                received_bytes: 0,
                state: DownloadState::Downloading,
                error: None,
            },
            cancel: Arc::new(AtomicBool::new(true)),
            directory: Some(Arc::new(OwnedDirectory(directory.clone()))),
        });
        manager.complete(&id, Ok(())).await;
        assert_eq!(
            manager.snapshot(&id).await.unwrap().state,
            DownloadState::Cancelled
        );
        assert!(!directory.exists());
        std::fs::remove_dir_all(cache).unwrap();
    }
    async fn transfer_fixture() -> (
        PathBuf,
        FileDownloads,
        DownloadSnapshot,
        Arc<OwnedDirectory>,
    ) {
        let cache = std::env::temp_dir().join(format!("download-test-{}", uuid::Uuid::new_v4()));
        let manager = FileDownloads::new(&cache).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let path = manager.root().unwrap().join(&id);
        std::fs::create_dir(&path).unwrap();
        let directory = Arc::new(OwnedDirectory(path));
        let snapshot = DownloadSnapshot {
            job_id: id,
            profile_id: "p".into(),
            session_id: "s".into(),
            path: "原始.bin".into(),
            name: String::new(),
            total_bytes: 0,
            received_bytes: 0,
            state: DownloadState::Downloading,
            error: None,
        };
        *manager.job.lock().await = Some(Job {
            snapshot: snapshot.clone(),
            cancel: Arc::new(AtomicBool::new(false)),
            directory: Some(directory.clone()),
        });
        (cache, manager, snapshot, directory)
    }
    #[tokio::test]
    async fn rpc_transfer_writes_original_bytes_and_confirms_hash() {
        let app = tauri::test::mock_app();
        let connections = RemoteConnections::default();
        let bytes = [0, 255, 17];
        connections
            .install_download_test_connection(move |frame| {
                Ok(match frame["method"].as_str().unwrap() {
                    "session.files.download.open" => {
                        json!({"downloadId":"token","name":"原始.bin","sizeBytes":3,"chunkBytes":2})
                    }
                    "session.files.download.chunk" if frame["params"]["offset"] == 0 => {
                        json!({"offset":0,"contentBase64":STANDARD.encode([0,255]),"eof":false})
                    }
                    "session.files.download.chunk" => {
                        json!({"offset":2,"contentBase64":STANDARD.encode([17]),"eof":true})
                    }
                    "session.files.download.finish" => {
                        json!({"sizeBytes":3,"sha256":format!("{:x}",Sha256::digest(bytes))})
                    }
                    other => panic!("unexpected RPC {other}"),
                })
            })
            .await;
        let (cache, manager, snapshot, directory) = transfer_fixture().await;
        transfer(
            app.handle(),
            &connections,
            &manager,
            &snapshot,
            "g",
            &AtomicBool::new(false),
            &directory,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(directory.0.join("原始.bin")).unwrap(), bytes);
        assert_eq!(
            manager
                .snapshot(&snapshot.job_id)
                .await
                .unwrap()
                .received_bytes,
            3
        );
        drop(directory);
        drop(manager);
        std::fs::remove_dir_all(cache).unwrap();
    }
    #[tokio::test]
    async fn cancel_after_complete_frame_closes_token_without_retiring_shared_connection() {
        let app = tauri::test::mock_app();
        let connections = RemoteConnections::default();
        let flag = Arc::new(AtomicBool::new(false));
        let cancel = flag.clone();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = seen.clone();
        connections
            .install_download_test_connection(move |frame| {
                let method = frame["method"].as_str().unwrap();
                observed.lock().unwrap().push(method.to_owned());
                Ok(match method {
                    "session.files.download.open" => {
                        json!({"downloadId":"token","name":"f.bin","sizeBytes":1,"chunkBytes":1})
                    }
                    "session.files.download.chunk" => {
                        cancel.store(true, Ordering::Release);
                        json!({"offset":0,"contentBase64":"AQ==","eof":true})
                    }
                    "session.files.download.close" => json!({"closed":true}),
                    other => panic!("unexpected RPC {other}"),
                })
            })
            .await;
        let (cache, manager, snapshot, directory) = transfer_fixture().await;
        assert_eq!(
            transfer(
                app.handle(),
                &connections,
                &manager,
                &snapshot,
                "g",
                &flag,
                &directory
            )
            .await
            .unwrap_err()
            .code,
            "cancelled"
        );
        assert_eq!(connections.download_generation("p").await.unwrap(), "g");
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "session.files.download.open",
                "session.files.download.chunk",
                "session.files.download.close"
            ]
        );
        drop(directory);
        drop(manager);
        std::fs::remove_dir_all(cache).unwrap();
    }
    #[tokio::test]
    async fn disk_failure_closes_token_and_wrong_generation_never_sends() {
        let app = tauri::test::mock_app();
        let connections = RemoteConnections::default();
        let closed = Arc::new(AtomicBool::new(false));
        let observed = closed.clone();
        connections
            .install_download_test_connection(move |frame| {
                Ok(match frame["method"].as_str().unwrap() {
                    "session.files.download.open" => {
                        json!({"downloadId":"token","name":"f.bin","sizeBytes":1,"chunkBytes":1})
                    }
                    "session.files.download.close" => {
                        observed.store(true, Ordering::Release);
                        json!({"closed":true})
                    }
                    other => panic!("unexpected RPC {other}"),
                })
            })
            .await;
        let (cache, manager, snapshot, directory) = transfer_fixture().await;
        assert_eq!(
            transfer(
                app.handle(),
                &connections,
                &manager,
                &snapshot,
                "obsolete",
                &AtomicBool::new(false),
                &directory
            )
            .await
            .unwrap_err()
            .code,
            "connection_changed"
        );
        std::fs::remove_dir(&directory.0).unwrap();
        assert_eq!(
            transfer(
                app.handle(),
                &connections,
                &manager,
                &snapshot,
                "g",
                &AtomicBool::new(false),
                &directory
            )
            .await
            .unwrap_err()
            .code,
            "disk_error"
        );
        assert!(closed.load(Ordering::Acquire));
        drop(directory);
        drop(manager);
        std::fs::remove_dir_all(cache).unwrap();
    }
    #[tokio::test]
    async fn cache_initialization_failure_is_managed_without_aborting_other_app_state() {
        let cache = std::env::temp_dir().join(format!("download-init-{}", uuid::Uuid::new_v4()));
        std::fs::write(&cache, [1]).unwrap(); // not a directory: deterministic storage failure
        let app = tauri::test::mock_app();
        // Same nonfallible initialization/management seam as lib.rs setup.
        assert!(app.manage(FileDownloads::initialize(Ok(cache.clone()))));
        assert!(app.manage(RemoteConnections::default()));
        let manager = app.state::<FileDownloads>();
        assert_eq!(manager.root().unwrap_err().code, "disk_error");
        assert!(manager.job.lock().await.is_none());
        assert!(app.try_state::<RemoteConnections>().is_some());
        assert_eq!(std::fs::read(&cache).unwrap(), [1]);
        std::fs::remove_file(&cache).unwrap();
        std::fs::create_dir(&cache).unwrap();
        // No implicit retry against a partially initialized root. The message
        // requests restart, and a new startup safely rechecks/sweeps the cache.
        assert!(manager.root().is_err());
        assert!(FileDownloads::initialize(Ok(cache.clone())).root().is_ok());
        std::fs::remove_dir_all(cache).unwrap();
    }
    #[tokio::test]
    async fn missing_cache_path_disables_only_downloads_without_a_fallback_path() {
        let manager = FileDownloads::initialize(Err(tauri::Error::UnknownPath));
        let initial = manager.root().unwrap_err();
        assert_eq!(initial.code, "disk_error");
        assert!(initial.message.contains("restarted"));
        assert!(manager.job.lock().await.is_none());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_permission_failure_is_nonfatal_but_fail_closed() {
        use std::os::unix::fs::PermissionsExt;
        // Root bypasses permissions. Actual execution in this task uses UID501.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let cache = std::env::temp_dir().join(format!("download-sweep-{}", uuid::Uuid::new_v4()));
        let root = cache.join("agentport-file-downloads");
        let stale = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("partial"), [1]).unwrap();
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o000)).unwrap();
        let manager = FileDownloads::initialize(Ok(cache.clone()));
        assert_eq!(manager.root().unwrap_err().code, "cleanup_failed");
        assert!(manager.job.lock().await.is_none());
        std::fs::set_permissions(&stale, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(stale.join("partial").exists());
        assert!(manager.root().is_err());
        let restarted = FileDownloads::initialize(Ok(cache.clone()));
        assert!(restarted.root().is_ok());
        assert!(!stale.exists());
        std::fs::remove_dir_all(cache).unwrap();
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn insecure_symlink_root_disables_downloads_instead_of_using_its_target() {
        use std::os::unix::fs::symlink;
        let cache =
            std::env::temp_dir().join(format!("download-init-link-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("download-init-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&cache).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), [1]).unwrap();
        symlink(&outside, cache.join("agentport-file-downloads")).unwrap();
        let manager = FileDownloads::initialize(Ok(cache.clone()));
        assert_eq!(manager.root().unwrap_err().code, "disk_error");
        assert!(manager.job.lock().await.is_none());
        assert_eq!(std::fs::read(outside.join("keep")).unwrap(), [1]);
        std::fs::remove_dir_all(cache).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
    #[tokio::test]
    async fn exporter_result_survives_cleanup_failure_with_destination_warning_priority() {
        for (status, state, code) in [
            ("saved", DownloadState::Saved, "saved_cleanup_failed"),
            ("cancelled", DownloadState::Cancelled, "cleanup_failed"),
            (
                "save_failed_leftover",
                DownloadState::Failed,
                "save_failed_leftover",
            ),
            ("save_failed", DownloadState::Failed, "cleanup_failed"),
        ] {
            let (cache, manager, snapshot, directory) = transfer_fixture().await;
            std::fs::remove_dir(&directory.0).unwrap();
            // A non-directory at the owned path deterministically makes local
            // cleanup fail even when tests run with elevated filesystem access.
            std::fs::write(&directory.0, [1]).unwrap();
            {
                let mut jobs = manager.job.lock().await;
                let job = jobs.as_mut().unwrap();
                job.snapshot.state = DownloadState::Saving;
                job.complete_export(Ok(status));
                assert!(job.directory.is_some()); // explicit discard can retry
            }
            let result = manager.snapshot(&snapshot.job_id).await.unwrap();
            assert_eq!(result.state, state);
            assert_eq!(result.error.unwrap().code, code);
            std::fs::remove_file(&directory.0).unwrap();
            drop(directory);
            drop(manager);
            std::fs::remove_dir_all(cache).unwrap();
        }
    }
    #[test]
    fn cleanup_errors_are_not_silently_reported_as_removed() {
        let file = std::env::temp_dir().join(format!("download-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, [1]).unwrap();
        let owned = OwnedDirectory(file.clone());
        assert_eq!(owned.cleanup().unwrap_err().code, "cleanup_failed");
        assert!(file.exists());
        std::fs::remove_file(file).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlink_root_and_sweeps_links_without_following() {
        use std::os::unix::fs::symlink;
        let cache = std::env::temp_dir().join(format!("download-link-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("download-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&cache).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("keep"), [1]).unwrap();
        let root = cache.join("agentport-file-downloads");
        symlink(&outside, &root).unwrap();
        assert!(FileDownloads::new(&cache).is_err());
        std::fs::remove_file(&root).unwrap();
        std::fs::create_dir(&root).unwrap();
        let link = root.join(uuid::Uuid::new_v4().to_string());
        symlink(&outside, &link).unwrap();
        FileDownloads::new(&cache).unwrap();
        assert!(!link.exists());
        assert!(outside.join("keep").exists());
        std::fs::remove_dir_all(cache).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
    #[test]
    fn startup_sweeps_owned_jobs_not_arbitrary_files() {
        let cache = std::env::temp_dir().join(format!("download-test-{}", uuid::Uuid::new_v4()));
        let root = cache.join("agentport-file-downloads");
        std::fs::create_dir_all(&root).unwrap();
        let old = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("partial"), [1, 2]).unwrap();
        std::fs::write(root.join("other"), [3]).unwrap();
        FileDownloads::new(&cache).unwrap();
        assert!(!old.exists());
        assert!(root.join("other").exists());
        std::fs::remove_dir_all(cache).unwrap();
    }
}
